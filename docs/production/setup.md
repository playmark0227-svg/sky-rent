# 本番環境の立ち上げ手順書

更新日: 2026-09-23 / 対象: グロースレンタカー 予約サイト・管理画面 (本番モード)

この手順書は、**エンジニアでない事業者の方が、上から順に作業すれば本番を立ち上げられる** ことを目標に書いています。
画面の名前やボタンの位置は各サービスの更新で少し変わることがあります。見つからないときは、同じ意味の項目を探してください。

> [!IMPORTANT]
> 本番公開の前に、[10章のチェックリスト](#10-本番公開前チェックリスト) をすべて満たしてください。
> 特に法務文書 (約款・特定商取引法に基づく表記・プライバシーポリシー) の最終確認が済むまでは、実際のお客様の予約を受け付けないでください。

---

## 目次

0. [全体像と準備するもの](#0-全体像と準備するもの)
1. [Supabase プロジェクトの作成](#1-supabase-プロジェクトの作成)
2. [データベースの作成 (link → db push → seed)](#2-データベースの作成-link--db-push--seed)
3. [Edge Functions の公開と秘密情報 (secrets) の設定](#3-edge-functions-の公開と秘密情報-secrets-の設定)
4. [ログイン (Auth) の設定](#4-ログイン-auth-の設定)
5. [メール送信サービス Resend の登録と DNS 設定](#5-メール送信サービス-resend-の登録と-dns-設定)
6. [Google カレンダー連携](#6-google-カレンダー連携)
7. [メール送信・カレンダー同期の定期実行 (worker)](#7-メール送信カレンダー同期の定期実行-worker)
8. [最初の管理者の作成と二段階認証](#8-最初の管理者の作成と二段階認証)
9. [公開サイトを本番モードにする (js/config.js)](#9-公開サイトを本番モードにする-jsconfigjs)
10. [本番公開前チェックリスト](#10-本番公開前チェックリスト)
11. [ローカル開発環境の起動方法 (開発者向け)](#11-ローカル開発環境の起動方法-開発者向け)
12. [困ったとき](#12-困ったとき)

---

## 0. 全体像と準備するもの

```
お客様・スタッフのブラウザ
   │  (HTML/CSS/JS は GitHub Pages からそのまま配信。今の公開 URL のままで OK)
   ▼
Supabase (東京リージョン)
   ├ データベース … 予約・会員・車両・料金設定・問い合わせ・操作履歴
   ├ Auth         … 会員のログイン (メール確認あり) / スタッフのログイン (二段階認証必須)
   └ Edge Functions
        ├ api     … 空き確認・見積・予約・キャンセル・問い合わせ
        ├ admin   … スタッフ招待・メール再送・カレンダー接続テスト
        └ worker  … メール送信・Google カレンダーへの書き込み (1分ごとに自動実行)
             ├→ Resend (メール送信)
             └→ Google Calendar API (担当者の予定の確認・予約の書き込み)
```

### 動作モード

| モード | 切り替え方 | データの置き場所 | 用途 |
|---|---|---|---|
| デモモード | `js/config.js` の `SUPABASE_URL` が空 | 閲覧している人のブラウザ内 (localStorage) | 画面確認・営業デモ。今の GitHub Pages の状態 |
| 本番モード | `js/config.js` に Supabase の URL とキーを書く | Supabase (東京) | 実運用 |

### 準備するもの

| もの | 用途 | 備考 |
|---|---|---|
| 会社のメールアドレス (共有できるもの) | Supabase・Resend・Google Cloud のアカウント | 担当者個人ではなく、引き継げるアドレスを推奨 |
| 独自ドメイン (例: `skyward-growth.com`) の DNS を編集できる権限 | メール送信元の認証 (SPF/DKIM) | ドメインを買った会社 (お名前.com など) の管理画面 |
| クレジットカード | Supabase 有料プラン、必要に応じて Resend | |
| Mac (推奨) またはパソコン | 2・3・8章のコマンド実行 | 「ターミナル」アプリを使います |
| パスワード管理ツール (1Password など) | この手順で作る秘密の値の保管 | **メモ帳・チャット・メールに貼らない** |
| スマートフォン | 管理画面の二段階認証 | Google Authenticator などの認証アプリ |

### この手順で作る「秘密の値」一覧 (すべてパスワード管理ツールに保存)

| 名前 | どこで作る | 誰が見てよいか |
|---|---|---|
| データベースのパスワード | 1章 (Supabase プロジェクト作成時) | 責任者のみ |
| service_role キー (secret キー) | 1章 (Supabase が発行) | 責任者のみ。**サイトや Git に絶対に書かない** |
| GUEST_TOKEN_SECRET | 3章 (openssl で生成) | 責任者のみ。**公開後は変更しない** (変えるとお客様の照会 URL が使えなくなります) |
| WORKER_SECRET | 3章 (openssl で生成) | 責任者のみ |
| Resend API キー | 5章 | 責任者のみ |
| Google サービスアカウント鍵 (JSON ファイル) | 6章 | 責任者のみ。登録後はパソコンから削除 |

---

## 1. Supabase プロジェクトの作成

**所要時間: 30分 / 担当: 責任者 (事業判断 A)**

### 1-1. 責任者とプランを決める

- **責任者** を1人決めます (Supabase の Owner。請求・障害対応・データの最終責任を持つ人)。予備にもう1人を Administrator にします。
- **プランは有料プラン (Pro 以上) を推奨** します。無料プランは一定期間使われないと停止し、自動バックアップもありません。
- **PITR (ポイントインタイムリカバリ) の追加を推奨** します。PITR があると「誤操作の直前 (秒単位)」の状態に戻せます。
  Pro の標準バックアップは1日1回なので、最大1日分の予約が失われる可能性があります (事業判断 O の RPO/RTO と合わせて決めてください)。
  PITR の料金と条件 (コンピュートのサイズなど) は契約時に Supabase の料金ページで確認してください。

### 1-2. アカウントと組織を作る

1. https://supabase.com/ を開き「Start your project」から、会社のメールアドレスでアカウントを作ります。
2. 右上のアカウントメニューのアカウント設定 (Security の項目) で、Supabase のアカウント自体にも二段階認証 (Multi-factor authentication) を設定します (全データを操作できるアカウントのため必須)。
3. **New organization** で組織を作ります (名前: `Skyward Growth` など)。プランは **Pro** を選び、支払い情報を登録します。
4. 共同で管理する人は **Organization settings → Team** から招待します。Owner は責任者のみにしてください。

### 1-3. プロジェクトを作る

1. **New project** を押し、次のとおり入力します。

   | 項目 | 入力する値 |
   |---|---|
   | Name | `growth-rentacar-prod` (任意) |
   | Database Password | 「Generate a password」で生成し、**パスワード管理ツールに保存** |
   | Region | **Northeast Asia (Tokyo)** |

2. **Create new project** を押し、数分待ちます。
3. 作成後、ブラウザのアドレス欄の `https://supabase.com/dashboard/project/xxxxxxxxxxxxxxxxxxxx` の `xxxx…` (英小文字20文字) が **プロジェクト ref** です。控えておきます。
4. **Project Settings → Add-ons** で PITR を有効にします (1-1 で決めた場合)。
5. 次の値を控えます。Project URL はプロジェクトのトップの **Connect** (または Project Settings → Data API)、
   キーは **Project Settings → API Keys** にあります (従来形式の anon / service_role は「Legacy API Keys」のタブ)。

   | 控える値 | どこで使う | 公開してよいか |
   |---|---|---|
   | Project URL (`https://<ref>.supabase.co`) | 9章 `js/config.js`、8章 | 公開してよい |
   | anon キー または Publishable キー (`sb_publishable_…`) | 9章 `js/config.js` | 公開してよい (データは RLS で守られています) |
   | service_role キー または Secret キー (`sb_secret_…`) | 8章 (管理者作成) だけ | **絶対に公開しない** |

---

## 2. データベースの作成 (link → db push → seed)

**所要時間: 30分 / 担当: 責任者または技術担当**

### 2-1. 道具を入れる (最初の1回だけ)

Mac の「ターミナル」アプリを開き、1行ずつ貼り付けて Enter を押します。

```bash
# Homebrew (Mac 用のインストーラ) が無い場合は https://brew.sh の手順で先に入れる
brew install supabase/tap/supabase node git

# ソースコードを取得 (GitHub のリポジトリ。ZIP でダウンロードして展開しても可)
git clone https://github.com/playmark0227-svg/sky-rent.git
cd sky-rent
```

### 2-2. Supabase にログインしてプロジェクトと結び付ける

```bash
supabase login                                   # ブラウザが開くので許可する
supabase link --project-ref <プロジェクト ref>    # データベースのパスワードを聞かれたら入力
```

### 2-3. テーブル等を作る (migrations) と初期データ (seed) を入れる

```bash
supabase db push --dry-run          # 何が作られるかの確認だけ (まだ変更しない)
supabase db push --include-seed     # 本番に反映 (確認を聞かれたら y)
```

- `supabase/migrations/*.sql` の順にテーブル・権限 (RLS)・予約処理・定期ジョブが作られます。
- `supabase/seed.sql` は **カタログと設定だけ** (拠点2・車両6台・補償オプション・料金ルール・法務文書の版) を入れます。架空の顧客や予約は入りません。
- seed の拠点の住所・電話、車両のナンバー等は仮の値です。**公開前に管理画面で実際の値に直してください** (10章)。

### 2-4. 確認

ダッシュボードの **SQL Editor** で次を実行し、結果を確認します。

```sql
select id, name from public.locations;          -- 北見本店・釧路店 の2行
select key from public.app_settings order by 1; -- billing, calendar, points, pricing_rules, site の5行
select jobname, schedule from cron.job;         -- skyrent-expire-points, skyrent-outbox-release の2行
```

`cron.job` が見つからない / 0行のときは、**Integrations → Cron** で Cron を有効にしてから、次を実行してください。

```sql
select cron.schedule('skyrent-expire-points', '10 18 * * *', 'select public.expire_points()');
select cron.schedule('skyrent-outbox-release', '*/10 * * * *', 'select public.outbox_release_stuck()');
```

> [!NOTE]
> 以後、データベースの変更 (新しい migration) を反映するときも `supabase db push` を使います。
> **`supabase db reset` は本番では絶対に実行しないでください** (データが消えます)。

---

## 3. Edge Functions の公開と秘密情報 (secrets) の設定

**所要時間: 30分 / 担当: 技術担当**

### 3-1. 秘密の値を作る

ターミナルで次を実行し、表示された値をパスワード管理ツールに保存します。

```bash
openssl rand -base64 48   # → GUEST_TOKEN_SECRET に使う (64文字)
openssl rand -hex 32      # → WORKER_SECRET に使う (64文字)
```

### 3-2. 環境変数の一覧

見本は `supabase/functions/.env.example` にあります (説明付き)。

| 変数 | 必須 | 本番で設定する値 / 作り方 |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | 自動 | **設定不要** (Supabase が自動で渡します。`SUPABASE_` で始まる名前は自分では設定できません) |
| `SITE_URL` | 必須 | 公開サイトの URL。**末尾に `/` を付ける**。例: `https://playmark0227-svg.github.io/sky-rent/` (メール内のリンクに使われます) |
| `ALLOWED_ORIGINS` | 必須 | サイトの「オリジン」(パス無し・末尾 `/` 無し)。例: `https://playmark0227-svg.github.io`。独自ドメインも使うならカンマ区切りで追加 |
| `GUEST_TOKEN_SECRET` | 必須 | 3-1 の `openssl rand -base64 48` の値 (32文字以上)。**公開後は変更しない** |
| `WORKER_SECRET` | 必須 | 3-1 の `openssl rand -hex 32` の値。7章の定期実行でも同じ値を使う |
| `RESEND_API_KEY` | 必須 | 5章で発行する Resend の API キー (`re_…`)。未設定だとメールは送られず「未送信 (skipped)」になります |
| `RESEND_API_BASE` | 不要 | 空のまま (既定 `https://api.resend.com`。テスト用の差し替え口) |
| `MAIL_FROM` | 必須 | 差出人。例: `グロースレンタカー <noreply@mail.skyward-growth.com>` (5章で認証したドメインのアドレス) |
| `SHOP_NOTIFY_EMAIL` | 必須 | 新規予約・キャンセル・問い合わせの通知を受け取る店舗のアドレス。複数ならカンマ区切り |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | カレンダー連携時 | 6章で作るサービスアカウント鍵 (JSON)。**base64 にして1行で** 設定 (下記) |
| `GOOGLE_API_BASE` / `GOOGLE_TOKEN_URL` | 不要 | 空のまま (既定 `https://www.googleapis.com` / 鍵の `token_uri`。テスト用の差し替え口) |
| `IP_HASH_SALT` | 推奨 | `openssl rand -hex 32` の値。予約・問い合わせの連続送信の制限で、お客様の IP アドレスをそのまま保存しないために使います (未設定なら GUEST_TOKEN_SECRET で代用) |
| `CLIENT_IP_HEADER` | 不要 | 空のまま。お客様の IP が特定のヘッダにしか入らない環境だけ、そのヘッダ名を入れます |

### 3-3. secrets を登録する

1. リポジトリ直下で、本番用の設定ファイルを作ります (このファイルは `.gitignore` 済みで Git には入りません)。

   ```bash
   cp supabase/functions/.env.example supabase/functions/.env.production
   open -e supabase/functions/.env.production    # テキストエディットで開いて値を埋める
   ```

   - 1行に `名前=値` の形で書きます。値に空白が入っていても、前後を `"` で囲む必要はありません。
   - テキストエディットを使う場合は、先にメニューの **編集 → 自動置換 → スマート引用符** をオフにしてください
     (`"` が `“` に変わると正しく読めません)。Visual Studio Code などのエディタでも構いません。

2. Google の鍵 (6章) は、次のコマンドで1行の文字列にして `GOOGLE_SERVICE_ACCOUNT_JSON=` の後ろに貼ります。

   ```bash
   base64 -i ~/Downloads/<ダウンロードした鍵>.json | tr -d '\n'   # Mac
   # Linux の場合: base64 -w0 <鍵>.json
   ```

3. まとめて登録します。

   ```bash
   supabase secrets set --env-file supabase/functions/.env.production
   supabase secrets list      # 名前が並んでいれば OK (値は表示されません)
   ```

4. 登録が済んだら `supabase/functions/.env.production` はパスワード管理ツールに保管し、パソコンからは削除します。

1つだけ変えるときは `supabase secrets set MAIL_FROM="グロースレンタカー <noreply@mail.skyward-growth.com>"` のように実行します。
secrets を変えたら、念のため 3-4 の deploy をもう一度実行してください。

### 3-4. Edge Functions を公開する

```bash
supabase functions deploy api admin worker
# Docker が入っていないパソコンでは:  supabase functions deploy api admin worker --use-api
```

- 3つとも `supabase/config.toml` で `verify_jwt = false` にしてあります (ログインの確認は関数の中で行います)。追加の指定は不要です。
- ダッシュボードの **Edge Functions** に api / admin / worker が表示されれば完了です。
- エラーの調査は **Edge Functions → (関数名) → Logs** で行います (ログに個人情報は出ません)。

---

## 4. ログイン (Auth) の設定

**所要時間: 20分 / 担当: 技術担当**

`supabase/config.toml` の Auth 設定は **ローカル開発用** です。本番はダッシュボードで同じ内容を設定します。

> [!WARNING]
> `supabase config push` は使わないでください。`config.toml` のローカル用の値 (Site URL `http://127.0.0.1:8901` など) で本番が上書きされます。

### 4-1. URL (Authentication → URL Configuration)

| 項目 | 値 |
|---|---|
| Site URL | `https://playmark0227-svg.github.io/sky-rent/` (独自ドメインにした場合はそちら) |
| Redirect URLs | `https://playmark0227-svg.github.io/sky-rent/**` を追加 (独自ドメインも使うなら同じ形で追加) |

メール内のリンク (登録確認・パスワード再設定・招待) は、ここに登録した URL にしか戻れません。

### 4-2. メールアドレス・パスワード (Authentication → Sign In / Providers → Email)

| 項目 | 設定 |
|---|---|
| Enable Email provider | ON |
| Allow new users to sign up | ON (お客様が会員登録するため) |
| Confirm email | **ON** (メール確認が済むまでログインできない) |
| Secure email change | ON (旧・新の両方のアドレスで確認) |
| Minimum password length | **8** |
| Password requirements | **Lowercase, uppercase letters and digits** (英小文字・英大文字・数字) |
| Prevent use of leaked passwords | ON (プランで使える場合) |

### 4-3. 二段階認証 (Authentication → Multi-Factor)

- **Authenticator app (TOTP)** を有効 (Enabled) にします。多くの場合、既定で有効です。
- 管理画面は、スタッフが二段階認証を通過したときだけデータを読めるようにデータベース側で制限しています。この設定が無効だとスタッフが誰もログインできません。

### 4-4. メール送信を Resend に向ける (Authentication → Emails → SMTP Settings)

Supabase 標準のメール送信は、ごく少数のテスト用です。**本番では必ず独自の SMTP を設定します** (先に5章で Resend を準備)。

| 項目 | 値 |
|---|---|
| Enable Custom SMTP | ON |
| Sender email | `noreply@mail.skyward-growth.com` (5章で認証したドメイン) |
| Sender name | `グロースレンタカー` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | Resend の API キー (`re_…`) |

設定後、**Authentication → Rate Limits** の「メール送信数の上限 (1時間あたり)」を、想定する会員登録・再設定の数に合わせて見直します (例: 100)。

### 4-5. メールの文面 (Authentication → Emails → Templates)

`supabase/templates/` の日本語テンプレートを貼り付けます。各テンプレートの **Subject** と **Message body** (HTML のソースをそのまま) を設定します。

| ダッシュボードのテンプレート | Subject (件名) | 本文ファイル |
|---|---|---|
| Confirm signup | 【グロースレンタカー】メールアドレスのご確認 | `supabase/templates/confirmation.html` |
| Invite user | 【グロースレンタカー】アカウントへのご招待 | `supabase/templates/invite.html` |
| Magic Link | 【グロースレンタカー】ログイン用リンクのお知らせ | `supabase/templates/magic_link.html` |
| Change Email Address | 【グロースレンタカー】メールアドレス変更のご確認 | `supabase/templates/email_change.html` |
| Reset Password | 【グロースレンタカー】パスワード再設定のご案内 | `supabase/templates/recovery.html` |

本文の `{{ .ConfirmationURL }}` などは Supabase が送信時に置き換える部分です。消さないでください。
問い合わせ先 (公式LINE `https://lin.ee/PuLt0Ig`) が変わったら、5つのファイルとダッシュボードの両方を直します。

---

## 5. メール送信サービス Resend の登録と DNS 設定

**所要時間: 30分 + DNS 反映待ち (数分〜最大48時間) / 担当: 責任者 + ドメイン管理者 (事業判断 K)**

予約確認・キャンセル・問い合わせ受付のメール (worker が送信) と、会員登録・パスワード再設定のメール (Auth が送信) の両方を Resend から送ります。

### 5-1. 送信に使うドメインを決める

- `github.io` からはメールを送れません。会社のドメインを使います。
- **既存のメール (例: `daichi.fujimoto@skyward-growth.com`) に影響しないよう、サブドメインを推奨** します。例: `mail.skyward-growth.com`
- 差出人は `noreply@mail.skyward-growth.com` のような送信専用アドレスにします (テンプレートに「返信不可・問い合わせは公式LINEへ」と記載済み)。

### 5-2. Resend に登録してドメインを追加する

1. https://resend.com/ で会社のメールアドレスを使ってアカウントを作り、二段階認証を設定します。
2. **Domains → Add Domain** で `mail.skyward-growth.com` を入力し、Region は **Tokyo (ap-northeast-1)** を選びます。
3. 画面に **DNS レコード** (MX・TXT) の一覧が表示されます。これをドメインの管理画面に登録します (次の 5-3)。

### 5-3. DNS に SPF・DKIM (と DMARC) を登録する

ドメインを管理している会社 (お名前.com、Cloudflare、ムームードメインなど) の「DNS 設定」画面で、Resend に表示された値を **そのまま** 追加します。

| 種類 | 名前 (ホスト) の例 | 値の例 | 意味 |
|---|---|---|---|
| MX | `send.mail` | `feedback-smtp.ap-northeast-1.amazonses.com` (優先度 10) | 送信エラーの受け取り |
| TXT | `send.mail` | `v=spf1 include:amazonses.com ~all` | **SPF**: このサービスからの送信を許可 |
| TXT | `resend._domainkey.mail` | `p=MIGfMA0GCSq…` (長い文字列) | **DKIM**: なりすまし防止の電子署名 |
| TXT | `_dmarc.mail` (推奨) | `v=DMARC1; p=none; rua=mailto:<受信できるアドレス>` | **DMARC**: 受信側への方針表示。Gmail 等の要件 |

- 値は必ず Resend の画面からコピーしてください (上の表は形の例です)。
- 「名前」欄にドメイン部分 (`.skyward-growth.com`) を自動で付ける管理画面と、付けない管理画面があります。Resend の画面の案内に合わせてください。
- 追加したら Resend の **Verify DNS Records** を押し、状態が **Verified** になるまで待ちます。

### 5-4. API キーを作る

1. Resend の **API Keys → Create API Key**。Permission は **Sending access**、Domain は 5-2 のドメインに限定します。
2. 表示されたキー (`re_…`) は一度しか表示されません。パスワード管理ツールに保存します。
3. このキーを **3章の `RESEND_API_KEY`** と **4-4 の SMTP Password** の両方に使います。

### 5-5. 到達確認

- 10章のテスト予約で、Gmail・Yahoo!メール・携帯キャリアメール (docomo / au / SoftBank) に届くか確認します。
- Gmail では、受信したメールの「︙ → メッセージのソースを表示」で `SPF: PASS`、`DKIM: PASS` を確認します。
- 携帯キャリアメールは「迷惑メール対策」で受信拒否されることがあります。予約ページや FAQ で「`mail.skyward-growth.com` からのメールを受信できるよう設定してください」と案内してください。

---

## 6. Google カレンダー連携

**所要時間: 40分 (+ 担当者ごとに5分) / 担当: 責任者 + 各担当者**

### 6-0. 何ができるか

- お客様が予約するとき、**車両を受け渡す担当者の Google カレンダーに予定が入っている時間 (または日) は選べなくなります**。
- 予約が入ると、担当者のカレンダーに「【貸出】R00012 マツダ CX-5 / 山田 太郎 様」「【返却】…」の予定が自動で書き込まれます。キャンセルされると予定は自動で消えます。
- 担当者が **終日の「休み」予定** を入れた日も「予定あり」として扱います (Google では終日予定は通常「予定なし」扱いですが、この連携では終日予定は必ず「予定あり」と見なします)。
- 仕組み: Google Cloud の **サービスアカウント** (ロボット用のアカウント) に、各担当者が自分のカレンダーを共有します。お客様や担当者の Google パスワードをシステムに預ける必要はありません。

### 6-1. Google Cloud プロジェクトを作る

1. 会社の Google アカウントで https://console.cloud.google.com/ を開きます。
2. 画面上部のプロジェクト選択 → **新しいプロジェクト**。名前: `growth-rentacar-calendar` → **作成**。
3. 作成したプロジェクトが選ばれていることを確認します。

### 6-2. Google Calendar API を有効にする

1. 左上メニュー → **API とサービス → ライブラリ**。
2. 「Google Calendar API」を検索して開き、**有効にする** を押します。

### 6-3. サービスアカウントを作る

1. 左上メニュー → **IAM と管理 → サービス アカウント → サービス アカウントを作成**。
2. サービスアカウント名: `skyrent-calendar` → **作成して続行**。
3. 「ロールを付与」「ユーザーにアクセス権を付与」は **何も選ばずに** **完了** を押します (カレンダーの権限は 6-5 の共有で与えます)。
4. 一覧に表示された **メールアドレス** (`skyrent-calendar@growth-rentacar-calendar.iam.gserviceaccount.com` のような形) を控えます。担当者に伝えるアドレスです。

### 6-4. 鍵 (JSON) を発行して secret に登録する

1. 作成したサービスアカウントを開き、**鍵 → 鍵を追加 → 新しい鍵を作成 → JSON → 作成**。JSON ファイルがダウンロードされます。
2. 3-3 の手順で base64 にして `GOOGLE_SERVICE_ACCOUNT_JSON` に登録し、`supabase secrets set` を実行します。
3. 登録が済んだら、ダウンロードした JSON ファイルはパスワード管理ツールに保管し、パソコン (ダウンロードフォルダ・ゴミ箱) から削除します。**メールやチャットで送らないでください。**

> [!NOTE]
> 「サービス アカウント キーの作成は無効になっています」と表示される場合は、Google Workspace の組織ポリシー
> (`iam.disableServiceAccountKeyCreation`) で禁止されています。組織の管理者に、このプロジェクトだけ例外にしてもらってください。
>
> 鍵が漏れた疑いがあるときは、同じ画面で古い鍵を **削除** し、新しい鍵を作って secret を登録し直します。

### 6-5. 各担当者が自分のカレンダーを共有する

受け渡しを担当する人が、**パソコンのブラウザで** 自分の Google カレンダーを開いて作業します (スマホのアプリではできません)。

1. https://calendar.google.com/ → 左の「マイカレンダー」で自分のカレンダーにマウスを乗せ **︙ → 設定と共有**。
2. **「特定のユーザーまたはグループと共有する」→「+ ユーザーやグループを追加」**。
3. 6-3 で控えたサービスアカウントのメールアドレスを入力し、権限は **「予定の変更」** を選んで **送信**。
4. 同じ設定画面の下の方 **「カレンダーの統合」→「カレンダー ID」** をコピーし、責任者に伝えます。
   - 自分のメインのカレンダーなら、カレンダー ID は Gmail のアドレス (例: `yamada@gmail.com`) です。
   - 追加で作ったカレンダーは `xxxxxxxx@group.calendar.google.com` の形です。
5. 同じ画面の **「タイムゾーン」** が **(GMT+09:00) 日本標準時** になっていることを確認します。

権限の違い:

| 共有の権限 | 連携でできること |
|---|---|
| **予定の変更** (推奨) | 予定の確認 (終日の「休み」も反映) + 予約の書き込み |
| 予定の表示 (すべての予定の詳細) | 予定の確認のみ。予約はカレンダーに書き込まれない |
| 予定の表示 (時間枠のみ) | 空き時間だけ確認。**終日の「休み」が反映されない**・書き込みもできない (接続テストで `freeBusyOnly` と表示) |

> [!NOTE]
> 会社の Google Workspace のカレンダーで「予定の変更」が選べない場合は、Workspace 管理者が
> **管理コンソール → アプリ → Google Workspace → カレンダー → 共有設定 → 外部共有オプション** を
> 「すべての情報を共有し、外部ユーザーによるカレンダーの変更を許可する」にする必要があります
> (サービスアカウントは組織の外部のアカウント扱いです)。

### 6-6. 管理画面で拠点ごとに登録し、接続テストする

1. 管理画面 (`manage/`) に管理者でログインし、サイドバーの **「Googleカレンダー連携」** を開きます。
2. サービスアカウントのメールアドレスが表示されていれば、鍵 (6-4) は正しく登録されています。
3. 拠点 (北見本店・釧路店) ごとに、6-5 で集めた **カレンダー ID** を登録します。
   - **1拠点に複数の担当者を登録できます。誰か1人でも空いていれば、その時間は予約できます。**
   - **予約の予定は、その拠点の「先頭」のカレンダーに書き込まれます。** 主担当の方を先頭にしてください。
   - 受け渡しを担当しない人のカレンダーや、予定を入れていない共用カレンダーは登録しないでください。
     「誰か1人でも空いていれば可」なので、いつも空いているカレンダーがあると全時間が予約可能になります。
4. カレンダーごとに **接続テスト** を押し、結果を確認します。

   | 表示 | 意味 | 対応 |
   |---|---|---|
   | `events` | 予定の確認と書き込みができる | OK |
   | `freeBusyOnly` | 空き時間しか見えない | 6-5 の権限を「予定の変更」に変えてもらう |
   | `none` / エラー | 共有されていない、またはカレンダー ID の誤り | 6-5 をやり直す。ID の前後の空白にも注意 |

5. 設定を確認して **連携を有効** にし、保存します。

### 6-7. 設定項目の意味

| 設定 (`app_settings.calendar`) | 既定 | 説明 |
|---|---|---|
| 連携を使う (`enabled`) | OFF | ON にすると、予約時に担当者の予定を確認し、予約を書き込みます |
| 判定の方法 (`mode`) | 受け渡し時刻 | 下の表を参照 |
| 受け渡しにかかる時間 (`handoverMinutes`) | 30分 | 貸出・返却の手続きに担当者が拘束される時間 |
| 受け渡しを重ねない (`oneHandoverAtATime`) | ON | 同じ拠点で、別の予約の貸出・返却時刻と「受け渡しにかかる時間」以内に近い時刻は選べなくします。**「連携を使う」が ON のときだけ効きます** |
| 予約をカレンダーに書き込む (`writeEvents`) | ON | 【貸出】【返却】の予定を担当者のカレンダーに書き込みます (予定は「予定なし」扱いで、空き判定には影響しません) |
| Google に接続できないとき予約を受ける (`failOpen`) | OFF | OFF: 接続できないときは「担当者の予定を確認できません」として予約を止めます (安全側)。ON: 予定を確認せずに予約を受けます |

**判定の方法 (モード) の違い**

| モード | 予約できる条件 | 向いている運用 |
|---|---|---|
| **受け渡し時刻** (`handover`) | 貸出時刻から30分間 と 返却時刻から30分間 のそれぞれで、登録した担当者のうち誰か1人の予定が空いている | 担当者が会議・外出などを時間単位でカレンダーに入れている |
| **1日単位** (`day`) | 貸出日 と 返却日 のそれぞれで、登録した担当者のうち誰か1人の予定が **その日1件も無い** | 担当者が「休み」だけを入れている。1時間の予定でもその日は受け渡し不可になります |

例 (受け渡し時刻モード、受け渡し30分、担当者 A だけ登録):

- A が 10:00〜12:00 に会議 → 10:30 貸出の予約は **不可** (10:30〜11:00 が会議と重なる)。12:00 貸出は **可**。
- A が 9/30 に終日の「休み」 → 9/30 は貸出・返却とも **不可**。
- A が「予定なし」にした予定・A が「不参加」と回答した予定・システムが書き込んだ【貸出】【返却】の予定 → 空き判定では **無視**。

補足:

- 予約画面の空き表示は Google の結果を最大5分キャッシュします。**予約確定の瞬間には必ず Google に直接確認** するので、確定後に重なることはありません。
- 担当者の予定の件名・内容はお客様には表示されません (「予定あり」の時間帯だけを使います)。
- 書き込む予定の説明には予約番号・車両・お名前・日時・管理画面の予約一覧へのリンクが入ります。**お客様の電話番号やメールアドレスは書き込みません。**
- 担当者が異動・退職したら、その人のカレンダーを管理画面から外し、本人に共有を解除してもらいます。

---

## 7. メール送信・カレンダー同期の定期実行 (worker)

**所要時間: 10分 / 担当: 技術担当**

予約や問い合わせのメール・カレンダーへの書き込みは「送信待ち (outbox)」に積まれ、worker が送ります。
予約直後は api がその場で worker を呼びますが、**失敗したものの再送や管理画面での変更の反映のために、1分ごとに worker を自動で呼ぶ設定が必要** です。

ダッシュボードの **SQL Editor** で、`<…>` の部分を書き換えてから実行します。

```sql
-- 1) HTTP 送信の拡張を有効にする (Database → Extensions で pg_net を ON にしても同じ)
create extension if not exists pg_net;

-- 2) 呼び出し先 URL と WORKER_SECRET を Vault (暗号化保管庫) に保存する
select vault.create_secret('https://<プロジェクト ref>.supabase.co', 'skyrent_project_url',
                           'worker の呼び出し先 (Supabase のプロジェクト URL)');
select vault.create_secret('<3章で作った WORKER_SECRET と同じ値>', 'skyrent_worker_secret',
                           'worker 起動用の共有秘密 (Edge Functions の WORKER_SECRET と同じ値)');

-- 3) 1分ごとに worker を呼ぶ
select cron.schedule(
  'skyrent-worker',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'skyrent_project_url') || '/functions/v1/worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'skyrent_worker_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
```

確認 (数分後に実行):

```sql
select jobname, schedule, active from cron.job;   -- skyrent-worker が増えて3行
select status, return_message, start_time
  from cron.job_run_details order by start_time desc limit 5;          -- succeeded が並ぶ
select status_code, left(content, 200) as body, created
  from net._http_response order by created desc limit 5;               -- 200 と {"ok":true…}
```

`net._http_response` が `401` のときは、Vault の WORKER_SECRET と 3章の secret の値が一致していません。

変更・停止するとき:

```sql
-- WORKER_SECRET を変えたとき (3章の secrets も同じ値に変える)
select vault.update_secret((select id from vault.secrets where name = 'skyrent_worker_secret'), '<新しい値>');

-- 定期実行を止める / 再開は 3) をもう一度実行
select cron.unschedule('skyrent-worker');
```

メールの送信状況は、管理画面の **「メール送信状況」** で確認・再送できます。

---

## 8. 最初の管理者の作成と二段階認証

**所要時間: 15分 / 担当: 責任者**

最初の1人の管理者はスクリプトで作ります。2人目以降は、管理画面の **「スタッフ・権限」** から招待します (招待メールが届きます)。

### 8-1. スクリプトで管理者を作る

リポジトリ直下 (2-1 で `cd sky-rent` した場所) で実行します。

```bash
npm install     # 最初の1回だけ

SUPABASE_URL="https://<プロジェクト ref>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service_role キー または sb_secret_ キー>" \
node scripts/create-admin.mjs --email owner@skyward-growth.com --name "藤本 大地"
```

- `--password '…'` を付けると、そのパスワードで作ります (8文字以上・英大文字/英小文字/数字を各1文字以上)。
  付けない場合は強いパスワードを自動で作り、**画面に1回だけ** 表示します。パスワード管理ツールに保存してください。
- 同じメールアドレスのユーザーが既にいる場合は、ユーザーは作らずスタッフ (管理者) の登録だけ行います (パスワードは変わりません)。
- 実行後、ターミナルの履歴にキーが残らないよう、ターミナルのウィンドウを閉じてください。
- 完了すると「スタッフ登録: 管理者 (admin・全拠点) として登録しました」と表示されます。

### 8-2. 初回ログインと二段階認証

1. スマートフォンに認証アプリを入れます: **Google Authenticator**、**Microsoft Authenticator**、1Password など。
2. `https://playmark0227-svg.github.io/sky-rent/manage/login.html` を開き、メールアドレスとパスワードでログインします。
3. 初回は **二段階認証の登録画面** が表示されます。認証アプリで QR コードを読み取ります (読み取れないときは表示された文字列を手入力)。
4. 認証アプリに表示される **6桁の数字** を入力すると登録完了です。以後のログインは「パスワード + 6桁の数字」になります。

> [!IMPORTANT]
> - 認証アプリを入れたスマホを紛失・機種変更すると、その人はログインできなくなります。**管理者は必ず2人以上** 登録してください。
> - 機種変更の前に、認証アプリの「アカウントを移行」機能で移すか、下の手順で登録をやり直します。
> - 二段階認証をやり直すとき: 責任者が 8-1 と同じ要領で次を実行すると、その人の二段階認証の登録が消え、
>   次回ログイン時に登録画面 (QR コード) が再び表示されます (役割やパスワードは変わりません)。
>   ```bash
>   SUPABASE_URL="https://<プロジェクト ref>.supabase.co" \
>   SUPABASE_SERVICE_ROLE_KEY="<service_role キー または sb_secret_ キー>" \
>   node scripts/create-admin.mjs --email <その人のメールアドレス> --reset-mfa
>   ```
>   本人確認 (電話・対面など) をしてから実行してください。

### 8-3. スタッフの役割

| 役割 | できること |
|---|---|
| admin (管理者) | すべて (設定・スタッフ管理・操作履歴を含む) |
| store_staff (店舗スタッフ) | 予約・会員・問い合わせ・お知らせ等の編集、メール送信状況、貸出停止枠 |
| accounting (経理) | 請求書・入金の管理、メール送信状況 |
| maintenance (整備) | 車両・カテゴリ・オプションの編集、貸出停止枠 |
| viewer (閲覧のみ) | 閲覧のみ |

スタッフごとに担当拠点を限定できます (限定すると他拠点の予約は見えません)。

---

## 9. 公開サイトを本番モードにする (js/config.js)

**所要時間: 10分 / 担当: 責任者**

**GitHub Pages のままで問題ありません。** サイト (HTML/CSS/JS) は今までどおり GitHub Pages から配信し、データだけ Supabase に置きます。

1. GitHub でリポジトリを開き、`js/config.js` を開いて鉛筆アイコン (Edit) を押します。
2. 次の2か所に、1章で控えた値を入れます。

   ```js
   window.SKY_RENT_CONFIG = {
     SUPABASE_URL: 'https://<プロジェクト ref>.supabase.co',
     SUPABASE_ANON_KEY: '<anon キー または sb_publishable_ キー>',
     FUNCTIONS_URL: '',            // 空のままで OK (SUPABASE_URL + /functions/v1 を使う)
     SITE_NAME: 'グロースレンタカー',
     AUTH_STORAGE: 'auto'          // そのままで OK (上の IMPORTANT を参照)
   };
   ```

3. **Commit changes** を押します。1〜2分で公開サイトに反映されます。
4. 公開サイトを開き、車両一覧が表示されること、会員登録画面などが動くことを確認します。

> [!CAUTION]
> ここに書くのは **anon (publishable) キーだけ** です。service_role / secret キーを書くと、誰でも全データを読み書きできてしまいます。
> 万一書いてしまったら、すぐに Supabase の **Project Settings → API Keys** でそのキーを無効化 (再発行) してください。

- デモモードに戻すときは、`SUPABASE_URL` と `SUPABASE_ANON_KEY` を空 (`''`) に戻します。
- デモモードでブラウザに保存された架空データは本番に移行されません (事業判断 M: デモデータは破棄)。
- 独自ドメインにする場合は、GitHub の **Settings → Pages → Custom domain** で設定し、4-1 の URL と 3章の `SITE_URL`・`ALLOWED_ORIGINS` にも追加します。

> [!IMPORTANT]
> **本番は独自ドメイン (例: `rent.skyward-growth.com`) での公開を強く推奨します。**
> `https://playmark0227-svg.github.io` は、同じ GitHub アカウントのすべてのリポジトリの公開ページと **同じオリジン** です。
> 別のリポジトリのページに入ったスクリプトから、このサイトのブラウザ保存領域を読めてしまいます。
> そのため `*.github.io` で動いている間は、ログイン状態をタブを閉じると消える場所 (sessionStorage) に保存する設定にしています
> (`js/config.js` の `AUTH_STORAGE: 'auto'`)。この間は、新しいタブで管理画面を開くたびにログインと二段階認証が必要です。
> 独自ドメインに切り替えると通常どおりログイン状態が保たれます。

---

## 10. 本番公開前チェックリスト

すべてにチェックが付くまで、実際のお客様の予約は受け付けないでください。

### 法務・事業判断

- [ ] [事業判断 A〜P](README.md#13-実装開始前の事業判断-ap) に担当者・回答・承認日がある ([現状監査 §10](current-state-audit.md#10-2026-09-23-実装状況) に未決の一覧あり)
- [ ] 貸渡約款 (`clause.html`)・特定商取引法に基づく表記 (`law.html`)・プライバシーポリシー (`privacy.html`) を専門家が確認し、事業者情報・許可番号・料金・キャンセル規定・補償に仮の記載 (空欄・「〇〇」等) が無い
- [ ] プライバシーポリシーに、委託先 (Supabase・Resend・Google) と、Google カレンダーへ予約情報 (予約番号・車両・お名前・日時) を登録することが書かれている
- [ ] サイト上の料金表・キャンセル規定と、管理画面の料金ルール (`pricing_rules`) が一致している
- [ ] 法務文書を改定したら、`legal_documents` の版 (version) を上げている (同意の記録に使われます)

### 実データ

- [ ] 拠点: 名称・住所・電話・営業時間・定休日が正しい (seed の仮の値を直した)
- [ ] 車両: 実車だけが「公開」になっている。ナンバー・定員・料金・写真・車検/点検日が正しい
- [ ] 補償オプション・割引・繁忙期・会社情報 (サイト設定)・振込先 (請求書払いを使う場合) が正しい
- [ ] Google カレンダー: 全拠点で接続テストが `events`、モードと受け渡し時間が運用と合っている

### セキュリティ・運用

- [ ] Supabase・Resend・Google Cloud・GitHub のアカウントに二段階認証を設定した
- [ ] 管理者が2人以上いて、全スタッフが二段階認証を登録済み。退職者のアカウントは無効化した
- [ ] service_role / secret キー・各種秘密の値が、サイトのファイル・Git・チャットに無い
- [ ] `ALLOWED_ORIGINS` と Auth の Redirect URLs が本番の URL だけになっている
- [ ] 7章の worker 定期実行が動いている (`cron.job_run_details` が succeeded)
- [ ] 管理画面「メール送信状況」を毎日確認する担当者を決めた

### バックアップと復元テスト

- [ ] **Database → Backups** にバックアップ (または PITR) が表示されている
- [ ] 一度、別の新しいプロジェクトへ復元 (Restore to a new project 等) を試し、予約データが見えることを確認した。所要時間を記録した (事業判断 O の RTO)。確認後、復元先のプロジェクトは削除した
- [ ] 障害時の連絡先 (責任者・Supabase サポート) と、お客様への告知方法 (公式LINE 等) を決めた

### 通しテスト (自分のメールアドレスで)

- [ ] 会員登録 → 確認メールが届く → リンクを開くとログインできる
- [ ] パスワード再設定メールが届き、新しいパスワードでログインできる
- [ ] テスト予約: 最終確認画面に料金内訳・支払方法・キャンセル規定が表示される → 確定 → 予約確認メールと店舗宛て通知が届く
- [ ] 担当者の Google カレンダーに【貸出】【返却】の予定が入る
- [ ] 担当者の予定がある時間・終日の「休み」の日は、予約画面で選べない
- [ ] 同じ車両・同じ時間でもう一度予約すると「埋まっています」と断られる
- [ ] 予約確認メールの照会 URL (またはマイページ) から予約を確認 → キャンセル → キャンセル料が規定どおり → キャンセルメールが届き、カレンダーの予定が消える
- [ ] 問い合わせフォーム → 受付メールと店舗宛て通知が届く
- [ ] Gmail・Yahoo!メール・携帯キャリアメールで迷惑メールに入らない (5-5)
- [ ] 管理画面の「操作履歴」に上の操作が記録されている
- [ ] テストで作った予約・会員は、管理画面でキャンセル/整理した (売上集計に入らないように)

---

## 11. ローカル開発環境の起動方法 (開発者向け)

本番とは別に、自分のパソコンの中で Supabase 一式を動かして開発・検証する方法です。

### 11-1. 必要なもの

```bash
brew install supabase/tap/supabase colima docker node
```

- Docker の実行環境は colima を使います (Docker Desktop でも可)。

### 11-2. 起動

```bash
cd sky-rent
colima start --cpu 4 --memory 8          # Docker を起動 (パソコンの再起動後は毎回)
supabase start                           # Postgres・Auth・Mailpit 等を起動 (初回はダウンロードで時間がかかる)
supabase status                          # URL・anon key・service_role key を表示
```

- `supabase start` は起動時に `supabase/migrations` と `supabase/seed.sql` を適用します。
- DB を作り直すとき: `supabase db reset` (ローカルのデータはすべて消えます)。
- `supabase/config.toml` を変えたら `supabase stop && supabase start` で反映します。

### 11-3. Edge Functions

```bash
cp supabase/functions/.env.example supabase/functions/.env.local   # 最初の1回。値を埋める (Git には入らない)
supabase functions serve --env-file supabase/functions/.env.local
```

- ローカルでは `RESEND_API_KEY` を空にするとメールは送られず「skipped」になります。
- worker を手で動かす: `curl -X POST http://127.0.0.1:54321/functions/v1/worker -H "x-worker-secret: <.env.local の WORKER_SECRET>"`
- Google カレンダーを本物につながずに試すときは、`GOOGLE_API_BASE` / `GOOGLE_TOKEN_URL` をテスト用のサーバーに向けます。

### 11-4. サイトを開く

```bash
npx --yes http-server . -p 8901 -a 127.0.0.1 -c-1     # または: python3 -m http.server 8901 --bind 127.0.0.1
```

1. http://127.0.0.1:8901/ を開きます (この状態はデモモード)。
2. ローカルの Supabase につなぐには、ブラウザの開発者ツールのコンソールで次を実行して再読み込みします
   (`localhost` / `127.0.0.1` で開いたときだけ有効な上書き設定です)。

   ```js
   localStorage.setItem('sky-rent.configOverride', JSON.stringify({
     SUPABASE_URL: 'http://127.0.0.1:54321',
     SUPABASE_ANON_KEY: '<supabase status の ANON_KEY>'
   }));
   // デモモードに戻す: localStorage.removeItem('sky-rent.configOverride')
   ```

3. 管理者を作ります。

   ```bash
   npm install
   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY='<supabase status の SERVICE_ROLE_KEY>' \
     node scripts/create-admin.mjs --email admin@example.com --name 管理者 --password 'Admin-Pass-2026'
   ```

### 11-5. 便利な画面

| 画面 | URL |
|---|---|
| Supabase Studio (データの閲覧・SQL) | http://127.0.0.1:54323 |
| Mailpit (ローカルで送られたメールの受信箱) | http://127.0.0.1:54324 |
| API | http://127.0.0.1:54321 |

### 11-6. 自動テスト

```bash
npm test               # 料金計算などのテスト (tests/*.test.mjs) と、共用ファイルの一致確認
npm run sync-shared    # js/pricing-core.js を直したら Edge Functions 側 (_shared) へコピー
npm run test:db        # DB の権限 (RLS)・業務ロジックのテスト (supabase test db)
```

### 11-7. 停止

```bash
supabase stop      # データは次回の start まで残る
colima stop
```

実装の約束ごと (関数名・データの形・画面の挙動) は [実装契約書](implementation-v1.md) を参照してください。

---

## 12. 困ったとき

| 症状 | 確認すること |
|---|---|
| 公開サイトに「サーバーに接続できません」等のエラーが出る | 9章の URL・キーの貼り間違い。Supabase のプロジェクトが停止 (Paused) していないか |
| 予約時に「担当者の予定を確認できません」 | 6-4 の鍵 (secret) が登録されているか、管理画面の接続テスト結果。Google 側の障害なら、一時的に「Google に接続できないとき予約を受ける」を ON にする判断も可 |
| 予約メールが届かない | 管理画面「メール送信状況」のエラー内容。`RESEND_API_KEY`・`MAIL_FROM` のドメインが Resend で Verified か。7章の定期実行 |
| 会員登録の確認メールが届かない | 4-4 の SMTP 設定、Resend の **Emails** 画面の送信ログ、迷惑メールフォルダ |
| 確認メールのリンクを開くとエラー | 4-1 の Site URL / Redirect URLs に公開サイトの URL があるか。リンクの有効期限切れ (もう一度送信) |
| スタッフが管理画面に入れない | 8-2 の二段階認証。スタッフが「無効」になっていないか (「スタッフ・権限」画面) |
| 予約がカレンダーに書き込まれない | 共有の権限が「予定の変更」か (接続テストで `events`)。「予約をカレンダーに書き込む」が ON か。7章の定期実行 |
