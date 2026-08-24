# Crawler sản phẩm — thêm một NGUỒN mới, không phải một hệ thống mới

Ngày: 2026-08-24

Tài liệu này viết bằng tiếng Việt vì người duyệt nó là chủ sản phẩm. **Code,
comment trong code và toàn bộ giao diện vẫn là tiếng Anh** theo đúng quy ước hiện
tại của repo.

Phạm vi: một repo — `clients/manager-push-product-wordpress` (web + worker).
Plugin `GPM_toshstack` **không đổi**: crawler không thêm bất kỳ endpoint nào cho
plugin.

**Trạng thái: thiết kế, chưa cài đặt.**

---

## 1. Đề bài, và chỗ đề bài không khớp với repo này

Yêu cầu ban đầu: crawl sản phẩm từ Shopify / WooCommerce / Etsy / Magento / site
lạ, rồi **xuất ra một file CSV 47 cột để import vào WooCommerce**, kèm một trang
`/admin/crawler` và route `/api/crawler` chạy Playwright ngay trong Next.js.

Đọc lại repo trước khi viết dòng code nào, có bốn chỗ đề bài giả định sai. Ghi ra
đây vì chúng là lý do bản thiết kế dưới đây trông rất khác:

| Đề bài giả định | Repo thật |
|---|---|
| Chưa có pipeline sản phẩm | Đã có đủ: `lib/sources/` → `lib/build-products.ts` → `applyOptions` → `previews` → job → plugin |
| Đích đến là **file CSV 47 cột** | App **đẩy thẳng** sản phẩm vào WooCommerce qua plugin (`lib/gop-client.ts`), không đi qua importer của Woo |
| Chạy serverless, cần `maxDuration`, `@sparticuz/chromium` | Chạy VPS + PM2, có **worker sống lâu** (`ecosystem.config.js`), Playwright đầy đủ chạy được |
| Cần tự viết chế độ "gộp listing thành simple", "ép category" | **Đã có sẵn**: `flattenVariants`, `forceCategory`, `forceTag` trong `lib/import-options.ts` |

Kết luận: crawler ở repo này **không phải một tính năng độc lập**. Nó là **một
nguồn dữ liệu thứ hai**, đứng ngang hàng với CSV, và mọi thứ phía sau nó đã tồn
tại.

### 1.1 Bốn thứ bị LOẠI khỏi phạm vi, và vì sao

Loại bỏ có chủ đích, không phải bỏ sót:

1. **Bộ ghi CSV 47 cột.** Toàn bộ mục CSV của đề bài tồn tại chỉ để đưa sản phẩm
   cho importer của WooCommerce. App này đưa thẳng cho plugin — tốt hơn hẳn: có
   variation thật, có `idempotency_key` chống trùng, có kết quả từng dòng
   (`ImportResult`). Viết thêm CSV 47 cột là viết một đường ống thứ hai, kém hơn,
   để cạnh một đường ống đang chạy tốt.
2. **Chế độ `real-simple` / `collapse-listing-to-simple`.** Đây chính là
   `flattenVariants` (`lib/import-options.ts:109`, mặc định `true`). Crawler
   **luôn** trả về hình dạng thật của sản phẩm (variable thì có `variations`), và
   để bước Options của wizard quyết định có làm phẳng hay không. Crawler tự làm
   phẳng là **phá mất thông tin** trước khi người dùng kịp chọn.
3. **`categoryName` / `categoryCount`.** Đã là `forceCategory` / `forceTag`
   (`lib/transform.ts:60`).
4. **Trang `/admin/crawler` và route `/api/crawler` chạy đồng bộ.** Xem §3.

---

## 2. Hình dạng: một nguồn, đặt cạnh CSV

`lib/sources/crawl/` soi gương `lib/sources/csv.ts`, và trả về đúng một kiểu:
`Product[]` của `lib/gop-client.ts:53`.

`lib/build-products.ts:50` hôm nay chỉ có một nhánh nguồn (`fromCsv`). Thêm nhánh
thứ hai:

```
fromCsv(form, options)     → SourceResult ┐
fromCrawl(form, options)   → SourceResult ┴→ applyOptions() → savePreview() → job → plugin
```

`SourceResult` (`lib/build-products.ts:143`) đã là `Omit<BuildResult, "options" |
"generatedSku">`, nên nhánh mới chỉ cần điền: `products`, `sourceLabel`,
`warnings`, `errors`, `skippedRows`, `columns` (rỗng), `dialect` (`null`),
`signature` (`null`).

**Không có gì phía sau bị sửa.** `applyOptions` (`lib/transform.ts:27`) vẫn chạy
nguyên: ép category/tag, làm phẳng variant, sinh SKU, sinh slug, và quan trọng
nhất là `idempotency_key` — nghĩa là **crawl hai lần rồi import hai lần cũng
không tạo sản phẩm trùng**, miễn `sourceId` giống nhau. Chúng ta được tính chất
này miễn phí, chỉ vì không viết đường ống riêng.

### 2.1 Ánh xạ sang `Product`

| Nguồn | `Product` |
|---|---|
| tiêu đề | `name` |
| mô tả HTML | `description` |
| tóm tắt | `short_description` |
| giá (đã giải mã, xem §6) | `regular_price`, `sale_price` |
| còn hàng | `instock`, `stock` |
| vendor / brand | `custom_meta` (plugin không có trường brand riêng) |
| danh mục | `categories: string[]`, giữ nguyên chuỗi `"Cha > Con"` |
| tag | `tags: string[]` |
| ảnh | `images: string[]`, phần tử đầu là ảnh đại diện |
| option (Size, Color) | `attributes: [{ name, values, visible: true, used_for_variation: true }]` |
| từng biến thể | `variations: [{ sku, regular_price, attributes: [{name, value}], image }]` |

Sản phẩm một biến thể mà option đúng bằng `[{ name: "Title", values: ["Default
Title"] }]` → `type: "simple"`, `variations: []`. Đây là quy ước riêng của
Shopify và phải xử lý ở adapter Shopify, không phải ở chỗ chung.

---

## 3. Chạy ở đâu: `kind` thứ tư trên bảng `job`

Crawl 500 sản phẩm mất vài phút, cần dừng được, cần log. Đó đúng là thứ
`worker/index.ts` đã làm cho ba loại run hiện có.

Thêm `"crawl"` vào `db/schema.ts:275`:

```ts
kind: text("kind", { enum: ["import", "purge", "update", "crawl"] })
```

- `storeId` = `null` (crawl không có site đích)
- `storeUrl` = URL shop bị crawl
- `storeLabel` = host của nó

Hai cột này `NOT NULL` và tên là "store", nhưng nghĩa của chúng — *"site mà run
này nói chuyện với"* — vẫn đúng cho một crawl. Đây là chỗ gượng duy nhất, và nó
rẻ hơn nhiều so với việc tách bảng riêng.

### 3.1 Cảnh báo đã có sẵn trong schema, phải làm theo

`db/schema.ts:266` có một cảnh báo do chính người thêm `kind` thứ ba viết:

> Thêm member này **không tạo ra một lỗi compile nào**, dù đã tưởng là có: mọi màn
> hình đều kiểm tra `kind === "purge"` rồi coi phần còn lại là import.

Nghĩa là thêm `"crawl"` sẽ **âm thầm** hiển thị crawl như một import. Bắt buộc:

1. `grep -rn 'kind === "purge"'` và `grep -rn '=== "import"'` toàn repo, xử lý
   từng chỗ (`worker/index.ts:346`, `:351`, `:279`-`:284`, và các màn hình).
2. Thêm member vào `JOB_KIND_LABELS` / `JOB_KIND_ICONS` / `JOB_KIND_TONES`
   (`lib/job-display.ts:30`). Đây là `Record<JobKind, …>` nên **có** báo lỗi
   compile — đó là lưới an toàn duy nhất tự động.
3. Loại crawl ra khỏi: retry-failed, schedule, results export. Một crawl không có
   dòng nào để retry.

### 3.2 Sản phẩm crawl được lưu ở đâu

Vào `job_item` (`db/schema.ts:493`) — bảng jsonb khoá theo job id, sinh ra để
*"payload của run không nằm trong bảng `job`, để list queue khỏi kéo theo vài MB
JSON"*. Với crawl, payload đó là **đầu ra** thay vì đầu vào. Cùng bảng, cùng lý
do; chiều đi của dữ liệu không phải điều bảng này quan tâm. Ghi comment tại chỗ.

### 3.3 Hàng đợi

Dùng lại đúng queue và đúng `runJob` (`worker/index.ts:158`). `runJob` rẽ nhánh
theo `state.kind`, thêm `runCrawl()` cạnh `runImport` / `runEdit` / `runPurge`.
`runCrawl` **không** đi qua `runBatches` — nó không có site để gọi.

Cờ dừng, bản ghi cancel bền vững, `job_log`, stream SSE, trang `/process/[id]`:
dùng lại nguyên. `job_log.stage` (`db/schema.ts:461`) thêm ba giá trị:
`"detect"`, `"discover"`, `"crawl"`.

---

## 4. Adapter

Một interface, năm cài đặt:

```ts
interface CrawlAdapter {
  name: PlatformName;
  detect(input: DetectInput): number;              // 0..1, chấm điểm
  discover(ctx: CrawlContext): Promise<string[]>;  // URL sản phẩm
  fetchProducts(ctx: CrawlContext): AsyncGenerator<Product>;
}
```

Mỗi adapter thử **đường nhanh** (fetch + JSON) trước, chỉ leo lên **đường chậm**
(trình duyệt) khi đường nhanh hỏng.

| Adapter | Đường nhanh (chạy ngay từ ngày đầu) | Đường chậm (cần cờ, §5) |
|---|---|---|
| `shopify` | `/products.json?limit=250&page=N`; chi tiết `/products/{handle}.js` | `/collections/all`, `sitemap_products_*.xml`, JSON-LD |
| `woocommerce` | Store API `/wp-json/wc/store/v1/products?per_page=100` (không cần auth); v3 REST nếu chủ shop tự đưa key | JSON-LD + `wp-sitemap.xml` |
| `magento` | `/graphql`, query `products(pageSize, currentPage)` | JSON-LD + `sitemap.xml` |
| `generic` | JSON-LD `@type: Product` → microdata → OG/`product:price:*` → `sitemap.xml` | DOM heuristic |
| `etsy` | *không có* — Etsy không mở JSON | trang listing, `il_fullxfull`, lọc ảnh review |

Nhận diện nền tảng chấm theo điểm, không theo một dấu hiệu duy nhất: header/cookie
(`x-shopify-*`, `wp-content`, `X-Magento-*`), `<meta name="generator">`, URL asset,
hình dạng đường dẫn. Người dùng luôn **ghi đè được** lựa chọn ở form.

### 4.1 Giá theo đơn vị nhỏ

- Shopify: số nguyên **cents** → chia 100.
- WooCommerce Store API: chuỗi đơn vị nhỏ + `currency_minor_unit` → chia
  `10^minor_unit`. **Không hard-code 100**: JPY và VND có `minor_unit = 0`, chia
  100 là sai giá 100 lần.

### 4.2 Phân trang

Shopify: tăng `page` đến khi mảng `products` rỗng. Woo: `X-WP-Total` /
`X-WP-TotalPages`. Magento: `total_count` trong `page_info`. Mọi vòng lặp đều có
**trần cứng** — xem §7.4.

---

## 5. Trình duyệt: có code, mặc định TẮT

Playwright vào `package.json`, nhưng đường chậm chỉ chạy khi `CRAWL_BROWSER=1`.

Chưa bật cờ, adapter cần trình duyệt sẽ **dừng với thông báo rõ ràng** —
*"This store renders products in the browser; enable the browser crawler to read
it"* — chứ **không** trả về nửa danh mục. Trả về một phần và im lặng là cách tệ
nhất: người vận hành import 40 sản phẩm rồi tưởng shop chỉ có 40.

Khi bật, trên VPS cần: `pnpm exec playwright install --with-deps chromium`
(~400 MB), và nâng `max_memory_restart` của `easyobot-worker` trong
`ecosystem.config.js` từ `2G` lên `3G`. Ghi vào `docs/deployment.md` (tiếng Việt,
đúng như tài liệu đó đang viết).

Dùng chung **một** browser context cho cả run, đóng lại khi run kết thúc — kể cả
khi run bị huỷ.

---

## 6. Tiền tệ: giải mã luôn, quy đổi thì KHÔNG tự động

`lib/import-options.ts:124` nói rất rõ về `displayCurrency`: *"DISPLAY ONLY… it
converts nothing: the number published is the number in the file."* Crawler
không được phá vỡ nguyên tắc đó một cách âm thầm.

Nên chia làm hai việc khác nhau:

1. **Giải mã** (luôn làm, không hỏi): cents → thập phân, đơn vị nhỏ →
   thập phân. Đây không phải quy đổi, chỉ là đọc đúng con số.
2. **Quy đổi** (mặc định TẮT): nếu người vận hành muốn, họ **tự gõ tỉ giá** vào
   form crawl. Khi đó ghi vào options của run: tiền tệ nguồn, tỉ giá, thời điểm.
   Log in ra một dòng: *"Prices converted VND → USD at 25,400 (rate entered by
   operator, 2026-08-24)."*

Không gọi API tỉ giá. Lý do: thêm một phụ thuộc mạng vào mọi lần crawl, và một
tỉ giá cũ hoặc một lần gọi hỏng sẽ **in giá sai vào shop của khách** mà không ai
nhìn thấy. Tỉ giá gõ tay thì tái lập được và truy vết được.

Etsy trả giá theo IP (từ VN sẽ ra VND). Adapter **phải ghi lại tiền tệ thật sự
nhận được**, và cảnh báo nếu nó khác tiền tệ người dùng đang nghĩ. Với Shopify,
thử `?currency=USD` trước; nếu shop không bán bằng USD thì tham số này không có
tác dụng — vẫn phải quay về tỉ giá gõ tay.

---

## 7. An toàn

### 7.1 SSRF — dùng lại guard đã có, không viết cái mới

`lib/outbound-url.ts` đã là *"một luật ở một chỗ"* cho hai tính năng
(image check, webhook). Crawler là **chỗ thứ ba**, và là chỗ nguy hiểm nhất: nó
đi theo link lấy từ HTML của người lạ, giữ body, và theo redirect.

Vậy nên mọi request ra ngoài của crawler đi qua `assertFetchableUrl()`
(`lib/outbound-url.ts:286`, hàm `async`) — bản kiểm tra mạnh, có **phân giải tên
miền và soi từng địa chỉ trả về**, chứ không phải `blockedReason()` chỉ so chuỗi.
Không có ngoại lệ, kể cả URL do adapter tự dựng.

### 7.2 robots.txt — từ chối cứng

Tải `robots.txt` trước, cache trong suốt run. Nếu đường dẫn sản phẩm bị
`Disallow` → run **fail** với thông báo rõ. **Không có nút bỏ qua.**

### 7.3 CAPTCHA

Nhận diện trang chặn (Cloudflare interstitial, marker reCAPTCHA/hCaptcha) và
dừng với thông báo. **Không giải, không né.** Đây là giới hạn có chủ đích của sản
phẩm, không phải thiếu sót.

### 7.4 Lịch sự và trần cứng

- Đồng thời tối đa 4 request/host, mặc định trễ 300 ms giữa các request cùng host.
  Tham chiếu: `IMAGE_CHECK_CONCURRENCY = 8` (`lib/image-check.ts:54`) cho ảnh, nên
  crawl trang HTML phải thấp hơn.
- Backoff luỹ thừa khi gặp 429/503; quá 3 lần thì bỏ host đó và ghi warning.
- User-Agent trung thực, có tên app và URL liên hệ.
- **Trần sản phẩm** = `maxProductsPerRun` của account (`lib/limits.ts:26`), giao
  với số người dùng nhập ở form. Không thêm khái niệm giới hạn mới.
- Trần số trang và trần thời gian chạy, để một sitemap vòng lặp không quay mãi.

### 7.5 Ảnh

Nâng URL thumbnail lên bản lớn nhất (Shopify: bỏ hậu tố `_400x`/`_grande`; Etsy:
`il_fullxfull`), lọc placeholder / ảnh review / ảnh của listing khác, rồi cắt
theo `imagesPerProduct`.

**Không** tự viết kiểm tra HEAD 200. Bước đó đã tồn tại và người dùng đã quen với
nó: `lib/image-check.ts` chạy ở bước Review của wizard, trên đúng những sản phẩm
này. Viết lại là có hai câu trả lời khác nhau cho cùng một câu hỏi.

---

## 8. Giao diện

### 8.1 Trang `/crawl` (mới)

Form, dùng component sẵn có trong `components/ui/`:

- Shop URL (bắt buộc)
- Platform: `auto` + ghi đè bằng tay
- Product limit
- Images per product
- Tiền tệ: tiền tệ nguồn (tự nhận, sửa được) + ô tỉ giá tuỳ chọn (§6)
- WooCommerce v3 key/secret (tuỳ chọn, chỉ hiện khi platform là woocommerce)

Bấm Start → tạo job `kind: "crawl"` → chuyển sang `/process/[id]`.

Thêm một mục vào `components/shell/nav.ts`.

### 8.2 Trang chi tiết run

`/process/[id]` đã stream log sẵn. Với `kind === "crawl"` thì:

- ẩn phần site đích / batch / kết quả từng dòng (crawl không có),
- hiện: nền tảng nhận được, số sản phẩm tìm thấy, số bỏ qua, tiền tệ,
- khi `completed`: nút **"Import these products"**.

### 8.3 Nối vào wizard

Nút đó dẫn tới `/import?crawl=<jobId>`. Bước 1 (Source) của
`app/(app)/import/import-wizard.tsx` thay vùng thả file bằng một dòng tóm tắt:
*"1,204 products from foo.myshopify.com"*, kèm nút đổi nguồn. Các bước Sites /
Options / Review **không đổi một dòng nào** — và đó là toàn bộ mục đích của thiết
kế này.

`POST /api/import/preview` gửi `crawlJobId` thay cho file; `build-products.ts` rẽ
sang `fromCrawl`.

---

## 9. Kiểm thử

Test hiện tại là script shell (`tests/e2e.sh`, `tests/isolation.sh`, …). Giữ đúng
kiểu đó.

- **Fixture, không có mạng.** Lưu payload thật đã cắt gọn vào
  `tests/fixtures/crawl/` (`shopify-products.json`, `woo-store-api.json`,
  `magento-graphql.json`, `etsy-listing.html`, `jsonld-generic.html`). Mỗi adapter
  parse fixture → so với `Product` mong đợi. Đây là phần dễ hỏng nhất khi các nền
  tảng đổi format, nên phải test được mà không phụ thuộc site sống.
- **`tests/crawl.sh`**: chạy một crawl thật, có giới hạn 5 sản phẩm, vào một shop
  Shopify công khai; bỏ qua nếu không đặt biến môi trường. Không để trong CI.
- Test riêng cho: giải mã đơn vị nhỏ với `minor_unit = 0` (VND/JPY), robots.txt
  chặn → fail, và URL nội bộ → `OutboundUrlError`.

---

## 10. Thứ tự làm

1. `types.ts` + `Product` mapping + fixture test cho `shopify` (không mạng).
2. `fromCrawl` trong `build-products.ts`, nối `/import?crawl=`.
3. `kind: "crawl"` + migration + **audit grep §3.1** + `job-display.ts`.
4. `runCrawl` trong worker, log + cancel.
5. Trang `/crawl` + phần crawl của `/process/[id]`.
6. Adapter `woocommerce`, `magento`, `generic`.
7. Đường chậm + Playwright sau cờ `CRAWL_BROWSER`, rồi `etsy`.
8. Cập nhật `docs/deployment.md`.

Bước 1–5 đã là một tính năng dùng được (Shopify), trước khi đụng tới trình duyệt.

**Chia làm hai kế hoạch cài đặt, không phải một.** Bước 1–5 là kế hoạch thứ nhất
và nó tự đứng được: crawl Shopify → import, không có Playwright, không có Etsy.
Bước 6–8 là kế hoạch thứ hai, viết sau khi kế hoạch thứ nhất đã chạy thật — vì
chính lúc đó mới biết `Product` mapping và log của crawl còn thiếu gì. Một kế
hoạch gộp cả tám bước sẽ dài tới mức không ai soát nổi.

---

## 11. Rủi ro đã biết

- **Nền tảng đổi endpoint.** `/products.json` bị chặn ngày càng nhiều. Đường dự
  phòng không phải tuỳ chọn — nhưng nó cũng là phần dễ hỏng nhất. Fixture test
  (§9) là cách duy nhất biết được là hỏng.
- **`kind` thứ tư.** Schema đã cảnh báo là không có lỗi compile. Nếu bỏ qua §3.1,
  crawl sẽ hiện ra như một import và nút retry sẽ làm điều vô nghĩa.
- **Etsy và các site sau Cloudflare** sẽ chặn. Chấp nhận kết quả một phần *có báo*,
  không cố né.
- **Pháp lý.** Crawl có thể vi phạm ToS của site đích. App bắt buộc theo
  `robots.txt`, không né CAPTCHA, và ghi log rõ đã crawl site nào — trách nhiệm
  cuối cùng thuộc về người vận hành, và tài liệu bán hàng phải nói thẳng điều đó.
