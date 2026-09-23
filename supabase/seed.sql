-- =====================================================================
-- 初期データ (本番にもそのまま入れてよいもの = カタログと設定のみ)
--   架空の顧客・予約・会員は入れない。
--   料金は「レンタカー 総合料金表 (2026年6月改定版)」に準拠。
-- =====================================================================

insert into public.locations (id, name, name_en, tel, address, hours, holiday, sort) values
  ('loc-kitami',  '北見本店', 'Kitami',  '', '北海道北見市', '9:00-19:00', 'なし (年中無休)', 1),
  ('loc-kushiro', '釧路店',   'Kushiro', '', '北海道釧路市', '9:00-18:00', 'なし (年中無休)', 2)
on conflict (id) do nothing;

insert into public.categories (id, name, name_en, type, icon, description, sort, custom_field_defs) values
  ('cat-rental', '一般レンタカー', 'Rental Car', 'vehicle', '🚗',
   '通勤・買い物・旅行・お仕事に。コンパクトからSUV・ミニバン・軽トラックまで。', 1,
   '[{"key":"bodyType","label":"ボディタイプ","type":"select","options":["コンパクト","SUV","ミニバン","軽トラック"],"filterable":true},
     {"key":"drive","label":"駆動方式","type":"select","options":["2WD","4WD"],"filterable":true},
     {"key":"mission","label":"トランスミッション","type":"select","options":["AT","MT"],"filterable":false},
     {"key":"navi","label":"カーナビ","type":"select","options":["有","無"],"filterable":false},
     {"key":"etc","label":"ETC車載器","type":"select","options":["有","無"],"filterable":false}]'),
  ('cat-kitchen', 'キッチンカー', 'Kitchen Car', 'vehicle', '🍳',
   'イベント出店・移動販売・開業テストに。営業許可対応の本格装備。', 2,
   '[{"key":"kitchenSize","label":"キッチン寸法","type":"text","unit":"","filterable":false},
     {"key":"equipment","label":"搭載機材","type":"text","unit":"","filterable":false},
     {"key":"sinks","label":"シンク数","type":"number","unit":"槽","filterable":false},
     {"key":"power","label":"電源容量","type":"number","unit":"W","filterable":false}]')
on conflict (id) do nothing;

insert into public.assets (id, category_id, location_id, name, name_en, capacity, price_hour, price_day,
                           image, photo, sort, custom_fields) values
  ('V001', 'cat-rental', 'loc-kitami',  '日産 ノート',         'Nissan Note',         5, 1100,  7700, '🚗', 'images/cars/note-black.jpg', 1,
   '{"bodyType":"コンパクト","drive":"2WD","mission":"AT","navi":"有","etc":"有"}'),
  ('V002', 'cat-rental', 'loc-kushiro', '日産 ノート e-POWER', 'Nissan Note e-POWER', 5, 1100,  7700, '🚗', 'images/cars/note-white.jpg', 2,
   '{"bodyType":"コンパクト","drive":"2WD","mission":"AT","navi":"有","etc":"有"}'),
  ('V003', 'cat-rental', 'loc-kitami',  'マツダ CX-5',         'Mazda CX-5',          5, 2200, 17000, '🚙', 'images/cars/cx5.jpg',        3,
   '{"bodyType":"SUV","drive":"4WD","mission":"AT","navi":"有","etc":"有"}'),
  ('V004', 'cat-rental', 'loc-kitami',  'トヨタ シエンタ',     'Toyota Sienta',       7, 2200, 17000, '🚐', 'images/cars/sienta.jpg',     4,
   '{"bodyType":"ミニバン","drive":"2WD","mission":"AT","navi":"有","etc":"有"}'),
  ('V005', 'cat-rental', 'loc-kitami',  '軽トラック',          'Kei Truck',           2, 1100,  7700, '🛻', '',                           5,
   '{"bodyType":"軽トラック","drive":"4WD","mission":"AT","navi":"無","etc":"無"}'),
  ('K001', 'cat-kitchen', 'loc-kitami', 'キッチンカー',        'Kitchen Car',         2, null, 22000, '🍳', '',                           6,
   '{"kitchenSize":"2400×1800×1900mm","equipment":"2槽シンク・換気扇・作業台・給排水タンク・冷蔵庫","sinks":2,"power":3000}')
on conflict (id) do nothing;

-- 補償オプション (1〜6時間の料金は price_short)
insert into public.options (id, name, price, price_short, price_type, category_ids, kind, exclusive_group, sort, extra) values
  ('OP101', '免責補償制度 (CDW)',   1650, 1100, 'per_day', '{cat-rental}',  'cover', 'cover', 1, '{"description":"事故時の免責負担ゼロ (最大5万円)"}'),
  ('OP102', '安心保証コース (PAP)', 3300, 2200, 'per_day', '{cat-rental}',  'cover', 'cover', 2, '{"description":"免責免除・NOC免除"}'),
  ('OP201', '免責補償制度 (CDW)',   3300, null, 'per_day', '{cat-kitchen}', 'cover', 'cover', 3, '{"description":"事故時の免責負担ゼロ (最大10万円)"}'),
  ('OP202', '安心保証コース (PAP)', 6600, null, 'per_day', '{cat-kitchen}', 'cover', 'cover', 4, '{"description":"免責免除・NOC免除"}')
on conflict (id) do nothing;

-- 設定
insert into public.app_settings (key, value) values
  ('points', '{"pointPerUse":1,"couponThreshold":10,"couponAmount":1000,"expiryMonths":12}'),

  ('pricing_rules', '{
    "version": "2026-06",
    "timezone": "Asia/Tokyo",
    "shortHoursMax": 6,
    "weekendHolidayFee": 330,
    "nightFee": 1100,
    "nightStartHour": 20,
    "nightEndHour": 8,
    "busyFee": 550,
    "busyPeriods": [
      {"name": "ゴールデンウィーク", "from": "04-26", "to": "05-05"},
      {"name": "年末年始", "from": "12-29", "to": "01-03"}
    ],
    "extraHolidays": [],
    "discounts": {
      "student":        {"label": "学生割引",         "amount": 1100, "minHours": 24, "proof": "学生証"},
      "corporate":      {"label": "法人割引",         "amount": 1100, "minHours": 24, "proof": "社員証・法人名でのご予約"},
      "dual_residence": {"label": "二地域居住者割引", "amount": 1100, "minHours": 24, "proof": "二地域居住者限定特別価格チラシ"},
      "shusei_club":    {"label": "守成クラブ会員割引", "amount": 3000, "minHours": 24, "proof": "守成クラブ会員であることが分かるもの", "categoryIds": ["cat-kitchen"]}
    },
    "cancellation": {
      "classOf": {"コンパクト": "compact", "軽トラック": "compact", "SUV": "large", "ミニバン": "large"},
      "categoryClass": {"cat-kitchen": "kitchen"},
      "normal": {
        "compact": [{"minDays": 3, "pct": 0}, {"minDays": 1, "pct": 30}, {"minDays": 0, "pct": 50}],
        "large":   [{"minDays": 3, "pct": 0}, {"minDays": 1, "pct": 30}, {"minDays": 0, "pct": 50}],
        "kitchen": [{"minDays": 14, "pct": 0}, {"minDays": 3, "pct": 50}, {"minDays": 0, "pct": 100}]
      },
      "busy": {
        "compact": [{"minDays": 7, "pct": 0}, {"minDays": 1, "pct": 30}, {"minDays": 0, "pct": 50}],
        "large":   [{"minDays": 7, "pct": 0}, {"minDays": 1, "pct": 30}, {"minDays": 0, "pct": 50}],
        "kitchen": [{"minDays": 14, "pct": 0}, {"minDays": 7, "pct": 20}, {"minDays": 3, "pct": 30}, {"minDays": 1, "pct": 50}, {"minDays": 0, "pct": 100}]
      },
      "noShowPct": 100
    },
    "noc": {
      "compact": {"drivable": 30000, "notDrivable": 60000},
      "large":   {"drivable": 30000, "notDrivable": 60000},
      "kitchen": {"drivable": 60000, "notDrivable": 150000}
    }
  }'),

  ('calendar', '{
    "enabled": false,
    "mode": "handover",
    "handoverMinutes": 30,
    "oneHandoverAtATime": true,
    "writeEvents": true,
    "failOpen": false,
    "locations": {"loc-kitami": {"calendarIds": []}, "loc-kushiro": {"calendarIds": []}}
  }'),

  ('billing', '{"bankName":"","accountType":"普通","accountNo":"","holder":""}'),
  ('site',    '{"shopName":"グロースレンタカー","company":"株式会社Skyward Growth","line":"https://lin.ee/PuLt0Ig","email":"daichi.fujimoto@skyward-growth.com"}')
on conflict (key) do nothing;

-- 公開中の法務文書 (内容を改定したら version を上げて新しい行を active にする)
insert into public.legal_documents (id, version, title, url, effective_at) values
  ('clause',  '2026-08', '貸渡約款',                   'clause.html',  '2026-08-01'),
  ('cancel',  '2026-08', 'キャンセル規定',             'law.html#cancel', '2026-08-01'),
  ('privacy', '2026-08', 'プライバシーポリシー',       'privacy.html', '2026-08-01'),
  ('law',     '2026-08', '特定商取引法に基づく表記',   'law.html',     '2026-08-01')
on conflict do nothing;
