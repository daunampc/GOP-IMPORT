# Crawler sản phẩm — thêm một NGUỒN mới, không phải một hệ thống mới

Ngày: 2026-08-24

Tài liệu này viết bằng tiếng Việt vì người duyệt nó là chủ sản phẩm. **Code,
comment trong code và toàn bộ giao diện vẫn là tiếng Anh** theo đúng quy ước hiện
tại của repo.

Phạm vi: một repo — `clients/manager-push-product-wordpress` (web + worker).
Plugin `GPM_toshstack` **không đổi**: crawler không thêm bất kỳ endpoint nào cho
plugin.

**Trạng thái: §1–§11 đã cài đặt xong cho `shopify`, `woocommerce`, `magento` và
`generic` (kế hoạch 1 + kế hoạch 2). `etsy` và §12 (extension Chrome) chưa
làm.** Tài liệu này được **cập nhật lại sau khi code chạy**, không để nguyên
bản thiết kế ban đầu — vì một tài liệu sai còn tệ hơn không có tài liệu. Mỗi
chỗ cài đặt đi khác bản đầu được đánh dấu bằng một khối
`> **Sửa so với bản đầu**` ngay tại mục của nó, kèm lý do, chứ không lặng lẽ
viết lại. Danh sách đầy đủ từng bước nằm ở `.superpowers/sdd/progress.md`; đây
là tóm tắt:

| § | Bản đầu | Thực tế |
|---|---|---|
| §4 | 5 adapter: `shopify`, `woocommerce`, `magento`, `generic`, `etsy` | kế hoạch 1 ship `shopify`; kế hoạch 2 ship thêm **`woocommerce`, `magento`, `generic`**; chỉ còn **`etsy`** chưa có dòng code nào, vì nó cần trình duyệt (§12) |
| §4 | WooCommerce: Store API, hoặc v3 REST nếu chủ shop tự đưa key | v3 REST **không xây**: chỉ dùng Store API công khai, không cần auth — lưu key của khách là một mặt bằng ứng dụng này không cần có |
| §4 | Magento: `/graphql`, không nói rõ verb | đi qua **GET**, vì `CrawlTransport` cố tình chỉ phơi ra một verb — đây đúng là chỗ trình duyệt của khách sẽ đứng thay ở §12, và một relay nhận POST tuỳ ý là mặt bằng lớn hơn nhiều để giao cho người khác |
| §4 | `generic`: JSON-LD → microdata → OG/`product:price:*` → sitemap | chỉ **JSON-LD và Open Graph**; bỏ microdata và DOM heuristic — cả hai cần duyệt cây DOM thật, viết bằng regex là cách một crawler bắt đầu bịa giá, nên để dành cho đường trình duyệt |
| §4 | Magento map cả `SimpleProduct` lẫn `ConfigurableProduct` | mọi sản phẩm map thành **`simple`**; đọc biến thể `ConfigurableProduct` cần một hình dạng GraphQL query khác cho mỗi sản phẩm — cố tình để lại chứ không xây nửa vời |
| §4.1 | mỗi adapter tự biết đơn vị nhỏ của tiền tệ nó đọc | `minorUnitFor` dọn về **một chỗ** trong `money.ts` trước khi kịp có ba bản sao — một tiền tệ thêm vào một chỗ mà quên hai chỗ kia là giá sai mười lần |
| §4.1 | so `sale_price` với `regular_price` để quyết có phải giảm giá không | thêm `lessThan` vào `money.ts`, so trên **đơn vị nhỏ nguyên**; cả ba adapter dùng nó — hai trong số đó trước so bằng `Number()` |
| §4.2 | Woo dừng trang theo header `X-WP-Total`/`X-WP-TotalPages`; Magento theo `total_count` trong `page_info` | **không đọc** header hay field đó ở đâu cả: cả hai dừng đúng kiểu Shopify — trang rỗng thì dừng; Magento vẫn xin `total_count`/`page_info` trong query nhưng nhận về rồi bỏ không dùng |
| §4 | `CrawlAdapter` có `discover(ctx): Promise<string[]>` là một method chung | không có `discover` trên interface; thay bằng **`robotsPaths`** (mỗi adapter tự khai path nó sắp gọi) và **`CrawlContext.isAllowed`** (cho adapter phát hiện URL lúc chạy — `generic`, từ sitemap — soát từng URL khi đọc tới) |
| §4.1 / §6 | giá tính bằng số thực (nhân/chia trực tiếp trên `number`) | `lib/sources/crawl/money.ts` giữ giá là **chuỗi**, đếm chữ số thay vì chia nổi, và **từ chối** một giá trị mất chữ số thập phân thay vì âm thầm làm tròn |
| §6 | thử `?currency=USD` trước khi hỏi tỉ giá tay | **không làm** — operator luôn phải tự gõ `sourceCurrency`, crawler tin đúng con số đó |
| §7.1 | SSRF guard với `fetch(url, { redirect: "follow" })` | `follow` để lọt guard ở hop chuyển hướng thứ hai; đổi sang `redirect: "manual"`, soi lại từng hop, có trần số hop |
| §7.2 | robots.txt so khớp theo tiền tố chuỗi | rule `*`/`$` thật của Shopify khớp **không trúng gì cả**; thêm dịch wildcard sang `RegExp` |
| §7.2 | orchestrator kiểm robots.txt cho **một** path cố định | mỗi adapter tự khai `robotsPaths` (xem hàng §4 ở trên) — path cũ chỉ đúng cho `shopify`, và hỏi site về một request ba trong bốn adapter không bao giờ gọi, mà lại quên hỏi về request thật của chúng |
| §7.4 | mỗi lượt gọi dựng transport riêng khi cần | hai transport làm mất độ trễ per-host giữa robots.txt và request đầu tiên; gộp về **một** transport, nâng trần độ trễ bằng `raiseDelayTo()` |
| §8.1 | `platform: auto` + ghi đè tay; `transport: browser` khoá kèm lý do | kế hoạch 1 chưa có `auto`, khoá 4/5 platform; **kế hoạch 2 xây `auto`**: chấm điểm mọi adapter trên một request trang chủ, điểm cao nhất thắng, không nhận diện được thì rơi về `generic` chứ không từ chối — form giờ chỉ khoá `etsy`. Trường `transport` vẫn **không hiện lên form**, vì `browser` vẫn chưa xây (§12, kế hoạch 3) |
| §8.2 | (không nói riêng ngôn ngữ của hộp thoại) | Cancel/Stop/Delete ban đầu tả một crawl bằng đúng câu chữ của import ("plugin đã ghi", "đã lên site"); sửa lại bằng bản dành riêng cho crawl |
| §10 bước 3 | cần một migration cho `kind: "crawl"` | **không cần** — `db/schema.ts:266` đã ghi rõ `kind` là enum ở mức TypeScript, không phải Postgres |

Một chỗ đã kiểm và **khớp đúng bản đầu**, ghi lại để người đọc không phải đoán:
§3.2 — sản phẩm crawl nằm ở `job_item`, đúng như thiết kế dưới đây.

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

> **Sửa so với bản đầu.** §10 bước 3 của tài liệu này liệt "migration" như một
> phần của việc thêm `kind: "crawl"`. Không có migration nào được tạo, và không
> cần: `db/schema.ts:266` — comment do chính người thêm `kind` thứ ba viết —
> đã ghi rõ *"A TS-level enum, not a Postgres one, so adding a member needs no
> migration."* `pnpm db:generate` không sinh ra file nào cho thay đổi này, và
> cơ sở dữ liệu không bị đụng tới trong suốt việc cài đặt.

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

> **Đi xa hơn bản đầu ở điểm 3.** Bản đầu chỉ yêu cầu loại crawl khỏi schedule
> bằng logic. Khi cài đặt, `lib/schedules.ts` đổi kiểu `kind` thành
> `Exclude<JobKind, "crawl">` — "một crawl không bao giờ được lên lịch" trở
> thành lỗi compile nếu có ai lỡ đi ngược lại, không còn chỉ là một quy tắc
> runtime phải nhớ.

### 3.2 Sản phẩm crawl được lưu ở đâu

Vào `job_item` (`db/schema.ts:493`) — bảng jsonb khoá theo job id, sinh ra để
*"payload của run không nằm trong bảng `job`, để list queue khỏi kéo theo vài MB
JSON"*. Với crawl, payload đó là **đầu ra** thay vì đầu vào. Cùng bảng, cùng lý
do; chiều đi của dữ liệu không phải điều bảng này quan tâm. Ghi comment tại chỗ.

**Khớp đúng bản đầu.** `runCrawl` trong `worker/index.ts` ghi đúng vào
`jobItems` khi crawl xong (`.insert(jobItems)...onConflictDoUpdate`) — không có
gì khác so với những gì viết ở trên.

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

> **Sửa so với bản đầu.** Bảng trên liệt năm adapter. Việc cài đặt tách làm hai
> kế hoạch (xem §10): **kế hoạch 1** ship `shopify`
> (`lib/sources/crawl/adapters/shopify.ts`); **kế hoạch 2** — bản đang chạy —
> ship thêm `woocommerce`, `magento` và `generic`. Chỉ `etsy` là còn chưa có
> một dòng code nào: nó không mở JSON, nên đọc được nó cần trình duyệt thật
> (§12), và đó là kế hoạch 3. `ADAPTERS` ở `lib/sources/crawl/index.ts` giờ có
> bốn phần tử; `adapterNamed()` (trước là `pickAdapter()`) từ chối `etsy` bằng
> một lỗi rõ ràng — *"Etsy needs the browser crawler"* — thay vì thử đoán.
>
> Interface `CrawlAdapter` thật cũng không giống khối code trên: không có
> `discover(ctx): Promise<string[]>` chung cho mọi adapter. Thay vào đó là
> **`robotsPaths: ReadonlyArray<string>`** — mỗi adapter tự khai những path nó
> sắp gọi, để kiểm với robots.txt đúng request sẽ thật sự xảy ra — và
> **`CrawlContext.isAllowed(pathname)`** cho adapter phát hiện URL lúc chạy
> chứ không biết trước: `generic` đọc URL từ sitemap, nên soát từng URL bằng
> `isAllowed` khi đọc tới, thay vì có thể khai trước trong `robotsPaths`.
>
> Ba chỗ khác giữa ba adapter mới và bảng thiết kế ở trên:
>
> - **WooCommerce v3 REST — không xây.** Store API công khai không cần auth,
>   và đó là toàn bộ lý do chọn nó: bắt chủ shop tự đưa API key rồi ứng dụng
>   này phải lưu, mã hoá và được tin cậy với chiếc key đó là một mặt bằng bảo
>   mật mà một tính năng chỉ-đọc không cần có. Không nơi nào trong code nhận
>   hay lưu bất kỳ credential nào cho crawler.
> - **Magento GraphQL đi qua GET, không phải POST.** `CrawlTransport`
>   (`lib/sources/crawl/types.ts`) cố tình chỉ phơi ra một verb —
>   `fetchText(url)` — vì đây đúng là chỗ trình duyệt Chrome của khách sẽ đứng
>   thay ở §12, và một relay có thể bị yêu cầu POST bất kỳ body nào là một mặt
>   bằng lớn hơn nhiều để giao cho người lạ so với một relay chỉ biết hỏi.
>   Một Magento install chỉ nhận POST cho `/graphql` sẽ khiến adapter báo lỗi
>   rõ ràng thay vì âm thầm thất bại.
> - **`generic` chỉ đọc JSON-LD và Open Graph, không microdata, không DOM
>   heuristic.** `lib/sources/crawl/html.ts` tự nói lý do: cả hai cần duyệt
>   cây DOM thật, còn "giả vờ" làm điều đó bằng regex là cách một crawler bắt
>   đầu bịa giá. Bị hoãn sang đường trình duyệt (§5/§12), nơi có một DOM thật
>   để duyệt.
>
> Và một chỗ tương tự cho `magento`: mọi sản phẩm map thành **`type: "simple"`**
> (`toProduct()` trong `magento.ts`) — kể cả những sản phẩm `ConfigurableProduct`.
> Đọc biến thể của nó cần một hình dạng GraphQL query khác cho mỗi sản phẩm;
> việc đó bị để lại có chủ đích thay vì xây nửa vời.

Nhận diện nền tảng chấm theo điểm, không theo một dấu hiệu duy nhất: header/cookie
(`x-shopify-*`, `wp-content`, `X-Magento-*`), `<meta name="generator">`, URL asset,
hình dạng đường dẫn. Người dùng luôn **ghi đè được** lựa chọn ở form.

> **Sửa so với bản đầu.** Kế hoạch 1 chưa có lựa chọn `auto` (xem §8.1). Kế
> hoạch 2 xây nó: `detectPlatform()` trong `lib/sources/crawl/index.ts` tốn
> đúng **một** request vào trang chủ, chấm điểm cả bốn adapter đã ship trên
> cùng response đó, và lấy điểm cao nhất. Dưới một ngưỡng (`DETECT_THRESHOLD`),
> không phải là một lỗi — request rơi về `generic`, vì đó chính xác là việc
> `generic` sinh ra để làm, và từ chối thẳng sẽ biến mọi shop lạ thành ngõ cụt.

### 4.1 Giá theo đơn vị nhỏ

- Shopify: số nguyên **cents** → chia 100.
- WooCommerce Store API: chuỗi đơn vị nhỏ + `currency_minor_unit` → chia
  `10^minor_unit`. **Không hard-code 100**: JPY và VND có `minor_unit = 0`, chia
  100 là sai giá 100 lần.

> **Sửa so với bản đầu, sau một bug thật.** Cả bản đầu và kế hoạch cài đặt định
> tính giá bằng số thực — nhân/chia trực tiếp trên `number`. Test viết ở Task 1
> bắt được: `Number("18.005") * 100` không ra `1800` mà ra `1800.4999999999998`,
> và phép quy đổi tỉ giá ở §6 cộng dồn sai số đó tiếp. Sửa: `lib/sources/crawl/
> money.ts` giữ giá là **chuỗi thập phân** suốt đường đi. `fromMinorUnits` /
> `fromDecimal` đếm chữ số thay vì chia nổi, và `convert()` nhân trên số nguyên
> (hàng trăm) rồi mới chia lại. Cả hai **từ chối** (`CrawlMoneyError`) một chuỗi
> có nhiều chữ số thập phân hơn `minorUnit` cho phép, thay vì âm thầm làm tròn
> sai giá.

> **Sửa so với bản đầu, tiếp — kế hoạch 2.** Hai điểm nữa lộ ra khi ba adapter
> mới cùng cần đến `money.ts`:
>
> - **`minorUnitFor` dọn về một chỗ.** Trước khi có adapter thứ hai, biết
>   VND/JPY có `minor_unit = 0` chỉ là kiến thức của Shopify. Thêm
>   `woocommerce`, `magento` (qua `generic` giá đọc theo `priceCurrency`) đúng
>   lúc bảng tiền tệ đó sắp bị chép tay thành ba bản — và một tiền tệ thêm vào
>   một bản mà quên hai bản kia là giá sai mười lần. Hàm này giờ sống một lần
>   trong `money.ts`, cả ba adapter gọi chung.
> - **Thêm `lessThan`.** Mỗi adapter đều phải tự quyết "giá này có phải giảm
>   giá không" (so `sale_price`/`final_price` với `regular_price`). Hàm mới so
>   trên **đơn vị nhỏ nguyên**, không qua số thực — cùng lý do `fromMinorUnits`/
>   `fromDecimal` tồn tại. Cả ba adapter đọc qua nó; hai trong số đó (`magento`,
>   `generic` trước khi có `lessThan` sẽ phải tự viết) đáng lẽ so bằng
>   `Number()`.

### 4.2 Phân trang

Shopify: tăng `page` đến khi mảng `products` rỗng. Woo: `X-WP-Total` /
`X-WP-TotalPages`. Magento: `total_count` trong `page_info`. Mọi vòng lặp đều có
**trần cứng** — xem §7.4.

> **Sửa so với bản đầu.** `woocommerce.ts` và `magento.ts` không đọc header
> `X-WP-Total`/`X-WP-TotalPages` hay field `total_count`/`page_info` ở đâu cả.
> Cả hai dừng đúng kiểu Shopify: tăng `page`, dừng khi trang trả về rỗng.
> `PRODUCTS_QUERY` của Magento vẫn xin `total_count page_info{current_page
> total_pages}` trong câu query — giữ nguyên từ bản thiết kế — nhưng không có
> dòng code nào đọc lại giá trị đó; hai field này bay theo response mà không ai
> dùng. Dừng theo trang rỗng đơn giản hơn và đủ đúng cho `MAX_PAGES = 200`
> đang có, nên không có bug thật nào bị bắt ở đây — chỉ là thiết kế tả một cơ
> chế mà code không dùng tới.

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

> **Có đường thứ hai cho đường chậm.** §12 mô tả cách chạy nó bằng **Chrome trên
> máy của khách** qua extension, thay vì Chromium trên VPS. Hai đường dùng chung
> toàn bộ adapter — khác nhau đúng ở chỗ ai đi lấy trang về.

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

> **Sửa so với bản đầu — một khoảng trống, chưa phải một quyết định có chủ
> đích.** Adapter Shopify của kế hoạch 1 **không** thử `?currency=USD`.
> Operator phải tự gõ `sourceCurrency` (mặc định `USD`) ở form `/crawl`, và
> crawler tin đúng con số đó khi chọn `minorUnit` để giải mã giá. Nếu shop thật
> sự bán bằng một tiền tệ khác, giá sẽ bị đọc sai số chữ số thập phân mà không
> có gì trên màn hình cảnh báo. Đây không phải một lựa chọn có ghi lý do như
> các mục khác trong bảng tóm tắt ở đầu tài liệu — kế hoạch cài đặt không nhắc
> tới đoạn này của thiết kế, nên nó rơi mất mà không ai quyết định bỏ. Để lại
> cho kế hoạch sau.

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

> **Sửa so với bản đầu, sau một lỗ SSRF thật.** Kế hoạch cài đặt ban đầu viết
> transport bằng `fetch(url, { redirect: "follow" })`. Với `follow`, Node tự đi
> theo chuỗi chuyển hướng và không gọi lại `assertFetchableUrl()` ở hop thứ
> hai — một host công khai đáp `302` sang `169.254.169.254` sẽ được đọc thay
> cho crawler, đúng lỗ mà `lib/outbound-url.ts` tồn tại để chặn. Sửa:
> `lib/sources/crawl/transport.ts` dùng `redirect: "manual"`, tự đi từng hop,
> gọi lại `assertFetchableUrl()` ở **mỗi** hop, và có trần `MAX_REDIRECTS = 5`
> để một chuỗi chuyển hướng vòng lặp không treo run.

### 7.2 robots.txt — từ chối cứng

Tải `robots.txt` trước, cache trong suốt run. Nếu đường dẫn sản phẩm bị
`Disallow` → run **fail** với thông báo rõ. **Không có nút bỏ qua.**

> **Sửa so với bản đầu.** Bản parser robots.txt đầu tiên chỉ so khớp **tiền tố
> chuỗi**. robots.txt thật của Shopify dùng `*` và `$` (ví dụ
> `Disallow: /*/checkouts/`) — so tiền tố với các rule đó **không khớp gì cả**,
> nên chúng trở thành no-op câm lặng và mục đích của cả mục này bị vô hiệu mà
> không ai biết. Sửa: `lib/sources/crawl/robots.ts` dịch mỗi pattern sang một
> `RegExp` (`matcherFor`), có xử lý `*` và `$`, trước khi so khớp; longest-match
> thắng, `Allow` phá vỡ trường hợp bằng nhau.

> **Sửa so với bản đầu, kế hoạch 2.** "Đường dẫn sản phẩm" ở trên từng là
> **một** path cố định (`/products.json` — đúng cho mỗi `shopify`) kiểm thay
> cho mọi adapter. Có thêm `woocommerce`/`magento`/`generic`, path đó sai cho
> ba trong bốn: hỏi site về một request sẽ không bao giờ xảy ra, và bỏ sót
> câu hỏi về request thật sự sắp gọi. Sửa ở `bc72b56`: mỗi `CrawlAdapter` tự
> khai `robotsPaths` (chi tiết ở khối sửa của §4), và orchestrator lặp qua
> đúng path của adapter đang chạy.

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

> **Sửa so với bản đầu.** Bản đầu (và kế hoạch cài đặt) dựng một
> `serverTransport` riêng để đọc robots.txt và một cái khác cho các request
> sản phẩm. Vì độ trễ per-host (`nextAllowedAt`) sống trong closure của
> transport, dựng hai bản làm mất đúng khoảng nghỉ giữa robots.txt và request
> sản phẩm đầu tiên — khoảng nghỉ lẽ ra phải chắc chắn có, vì site vừa tự nói
> ra `Crawl-delay` của nó. Sửa: `crawlShop()` dựng **một** transport cho toàn
> bộ run, và nâng trần độ trễ của nó bằng `raiseDelayTo()` sau khi đọc
> robots.txt — hàm chỉ nâng, không hạ.

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
- **Transport**: `server` (mặc định) hoặc `browser` — đi qua Chrome của khách (§12).
  Ô `browser` bị khoá và ghi lý do khi chưa có thiết bị nào online.

> **Sửa so với bản đầu — kế hoạch 1, đã cũ.** (Giữ lại vì đây là chỗ ghi rằng
> nó từng đúng.) Ở kế hoạch 1, không có tuỳ chọn `auto`: chỉ một adapter thì
> một bộ nhận diện chỉ có thể trả lời "shopify", và một câu trả lời tự động
> thực ra là một hằng số đội lốt; form khoá 4/5 tên không phải `shopify`.
>
> **Kế hoạch 2 — bản đang chạy — xây `auto`.** `CRAWL_PLATFORMS`
> (`lib/crawl-options.ts`) vẫn liệt cả 5 tên như thiết kế, và giờ `auto` là
> **giá trị mặc định** của form (`DEFAULT_CRAWL_OPTIONS.platform`), không còn
> bị khoá: `detectPlatform()` chấm điểm cả bốn adapter đã ship trên một
> request trang chủ (chi tiết ở khối sửa của §4). Bullet **"WooCommerce v3
> key/secret"** ở trên không có trên form và không có trong schema
> (`crawlOptionsSchema`): Store API không cần nó, nên trường này chưa từng
> được xây — không phải bị khoá, mà không tồn tại, đúng kiểu `Transport` bên
> dưới.
>
> Trường **Transport vẫn không xuất hiện trên form** — không phải bị khoá kèm
> lý do như thiết kế định. `browser` vẫn chưa được xây (§12, kế hoạch 3), nên
> `CrawlForm` luôn gửi `transport: "server"`, và route `POST /api/crawl` từ
> chối bất kỳ giá trị khác ngay lúc tạo run — đúng tinh thần "fail ngay,
> không xếp hàng rồi treo" của §12.10, chỉ khác là lý do không phải "chưa có
> thiết bị nào online" mà là transport đó chưa tồn tại. Duy nhất `etsy` còn bị
> khoá trên form, với ghi chú "Needs the browser crawler".

Bấm Start → tạo job `kind: "crawl"` → chuyển sang `/process/[id]`.

Thêm một mục vào `components/shell/nav.ts`.

### 8.2 Trang chi tiết run

`/process/[id]` đã stream log sẵn. Với `kind === "crawl"` thì:

- ẩn phần site đích / batch / kết quả từng dòng (crawl không có),
- hiện: nền tảng nhận được, số sản phẩm tìm thấy, số bỏ qua, tiền tệ,
- khi `completed`: nút **"Import these products"**.

> **Sửa so với bản đầu, sau một bug thật.** Các hộp thoại Cancel/Stop/Delete
> trên `/process/[id]` (`job-detail-view.tsx`) ban đầu dùng đúng câu chữ của
> một import cho cả crawl — "the plugin may already have committed the
> batch", "products already published are not touched" — dù một crawl không
> gọi plugin và không viết vào site nào. Reviewer bắt được ở bước cài đặt.
> Sửa: mỗi hộp thoại có một nhánh riêng khi run là crawl, nói đúng sự thật của
> nó — không có gì trên site để hoàn tác, và Cancel/Stop chỉ bỏ dữ liệu đã đọc
> mà chưa kịp đưa vào wizard.

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
9. Extension + kênh SSE/hàng đợi + ghép đôi thiết bị (§12).

Bước 1–5 đã là một tính năng dùng được (Shopify), trước khi đụng tới trình duyệt.

**Chia làm hai kế hoạch cài đặt, không phải một.** Bước 1–5 là kế hoạch thứ nhất
và nó tự đứng được: crawl Shopify → import, không có Playwright, không có Etsy.
Bước 6–8 là kế hoạch thứ hai, viết sau khi kế hoạch thứ nhất đã chạy thật — vì
chính lúc đó mới biết `Product` mapping và log của crawl còn thiếu gì. Một kế
hoạch gộp cả tám bước sẽ dài tới mức không ai soát nổi.

Bước 9 là **kế hoạch thứ ba**, và nó phụ thuộc vào hai kế hoạch trước theo nghĩa
chặt: extension chỉ là ống dẫn cho adapter đã có, nên xây nó trước khi có adapter
là xây một cái ống chưa biết sẽ chở gì.

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
- **Extension bị Google từ chối hoặc gỡ.** Một extension có tính chất thu thập dữ
  liệu luôn có rủi ro này, kể cả bản Unlisted. Giảm thiểu: xin quyền theo từng
  host lúc chạy thay vì `<all_urls>`, và mô tả rõ mục đích. Nếu bị gỡ, đường
  `transport: server` (§12.10) vẫn chạy nguyên — tính năng chính không chết theo.
- **Service worker của MV3 bị ngắt giữa một crawl dài.** Rủi ro kỹ thuật lớn nhất
  của §12, và là thứ **phải đo trước** khi viết tiếp (§12.8).
- **Confused deputy.** Extension fetch bằng danh tính của khách. Nếu allowlist theo
  host bị đặt nhầm ở phía server thay vì phía extension (§12.6), một account bị
  chiếm sẽ đọc được dữ liệu riêng tư của khách. Đây là chỗ dễ làm sai nhất trong
  toàn bộ tài liệu này.

---

## 12. Kết nối Chrome trên máy của khách

Bổ sung ngày 2026-08-24, sau khi §1–§11 đã được duyệt. Đây là **kế hoạch cài đặt
thứ ba**, làm sau cùng — không phải vì kém quan trọng, mà vì nó chỉ có nghĩa khi
adapter và job crawl đã chạy thật.

### 12.1 Ràng buộc không thể đi vòng

Worker chạy trên VPS `easyobot.com`. Chrome của khách chạy trên máy khách, **sau
NAT**. Server **không có đường nào gọi vào** `localhost:9222` của khách.

Nên mọi thiết kế đều phải là: **máy khách chủ động nối ra**. Không có lựa chọn
nào khác, và mọi phương án dưới đây chỉ khác nhau ở *cái gì* nối ra.

### 12.2 Extension là ỐNG DẪN, không phải crawler

Chọn: **Chrome extension**, phát hành **Unlisted** trên Chrome Web Store.

Và điều quan trọng nhất của cả mục này: extension **không chứa một dòng logic
crawl nào**. Nó nhận đúng hai lệnh và không hiểu gì về Shopify hay Etsy.

Lý do là §11: *"nền tảng đổi endpoint"* là rủi ro dễ xảy ra nhất. Nếu adapter nằm
trong extension thì mỗi lần Shopify đổi `/products.json` là phải build lại, nộp
lại, **chờ Google duyệt** — trong khi khách đang không crawl được. Adapter nằm ở
worker thì sửa xong là chạy, không ai phải cài lại gì.

Hệ quả kèm theo: extension nhỏ, ít quyền, dễ duyệt, và gần như không bao giờ cần
cập nhật.

### 12.3 Kênh truyền: SSE + POST, KHÔNG WebSocket

Next.js route handler không nhận WebSocket upgrade, và dựng thêm một process thứ
ba chỉ để giữ WebSocket là thêm một thứ nữa để triển khai sai. Repo này đã có sẵn
**đúng khuôn mẫu cần dùng**: SSE ở `app/api/jobs/stream/route.ts:108` và
`app/api/jobs/[id]/logs/stream/route.ts:158`.

- Extension mở `GET /api/crawl/agent/stream` (SSE) → **nhận lệnh**.
- Extension `POST /api/crawl/agent/result` → **trả kết quả**.

Hai chiều, hai request, không cần WebSocket.

#### 12.3.1 Nối web process với worker: hàng đợi, KHÔNG pub/sub

Chỗ này phải nói kỹ, vì làm sai là hỏng âm thầm.

`lib/redis.ts:33` phát biểu nguyên tắc của repo: *"Losing a published message
costs responsiveness, never correctness"* — pub/sub ở đây **chỉ là tiếng gõ cửa**,
dữ liệu thật luôn nằm ở Postgres. `STOP_CHANNEL` và `LOG_CHANNEL` đều chỉ chở một
run id.

**Lệnh fetch gửi cho extension thì ngược lại: nó CHÍNH LÀ dữ liệu.** Mất một lệnh
là crawl treo giữa chừng. Nên tuyệt đối không dùng `publish()` cho việc này.

Dùng list của Redis — Redis đã là hàng đợi thật ở repo này rồi, vì BullMQ:

```
worker:     LPUSH  crawl:dev:<deviceId>:cmd        {id, kind, url, ...}
            BRPOP  crawl:cmd:<cmdId>:res  <deadline>
web (SSE):  BRPOP  crawl:dev:<deviceId>:cmd        → đẩy xuống extension
web (POST): LPUSH  crawl:cmd:<cmdId>:res           {status, body, ...}
```

Mọi key đều có TTL. Worker chờ có hạn; quá hạn thì coi như thiết bị mất kết nối,
ghi warning và **dừng run với thông báo rõ**, không im lặng bỏ qua sản phẩm.

### 12.4 Giao thức: đúng hai lệnh

| Lệnh | Extension làm gì | Trả về |
|---|---|---|
| `fetch` | `fetch(url)` ngay trong extension, kèm cookie của khách nếu host được phép | `{status, headers, body}` |
| `render` | Mở tab ẩn, chờ tải xong, cuộn để ảnh lazy load, đọc DOM, đóng tab | `{status, finalUrl, html}` |

`fetch` đủ cho Shopify, Woo, Magento — vốn trả JSON. `render` dành cho trang dựng
bằng JS, tức là Etsy và các shop có theme render phía client.

Cả hai đều có **trần dung lượng** (mặc định 8 MB) và **trần thời gian** (30 giây).
Vượt trần thì trả lỗi, không trả một phần.

### 12.5 Ghép đôi thiết bị

Không bắt khách dán license key vào extension. Thay vào đó:

1. Khách đăng nhập web, vào `/crawl`, bấm **"Connect my Chrome"** → hiện mã 6 số,
   sống 5 phút (lưu ở Redis, có TTL).
2. Bấm vào extension, gõ mã.
3. Server phát một **device token** dài hạn, chỉ trả về đúng một lần.

Bảng mới `crawl_devices`: `id`, `ownerId`, `label`, `platform` (`macos` |
`windows`), `tokenHash`, `createdAt`, `lastSeenAt`, `revokedAt`.

Ở `/settings` có bảng danh sách thiết bị đã nối, kèm lần cuối online và nút
**Revoke**. Token lưu dạng hash, không lưu bản rõ — cùng cách repo đang làm với
các bí mật khác.

Thiết bị thuộc **account**, nên nó đi theo đúng cơ chế cô lập per-account đang có.

### 12.6 An toàn: extension là một "confused deputy"

Đây là rủi ro nghiêm trọng nhất của cả tính năng, phải nói thẳng.

Extension fetch **bằng danh tính của khách**. Nếu nó nhận lệnh từ server một cách
vô điều kiện, thì bất kỳ ai chiếm được account — hoặc chính server nếu bị xâm nhập
— đều có thể ra lệnh `fetch https://mail.google.com` và **đọc hộp thư của khách**.

Ba lớp chặn, và lớp quan trọng nhất nằm ở phía extension chứ không phải server:

1. **Allowlist theo host, do EXTENSION tự giữ.** Trước khi crawl chạy, extension
   hiện ra danh sách host sẽ truy cập (host của shop + CDN của nó) và **khách bấm
   đồng ý**. Sau đó extension **từ chối mọi lệnh có host ngoài danh sách đó**.
   Server không có quyền mở rộng danh sách này giữa chừng. Đây là lớp duy nhất còn
   đứng vững khi server bị xâm nhập, nên nó phải nằm ở extension.
2. **Quyền xin theo từng host lúc chạy** (`chrome.permissions.request`), không
   xin `<all_urls>` trong manifest. Vừa đúng tinh thần bản Unlisted, vừa làm bản
   duyệt của Google nhẹ đi.
3. **Chặn địa chỉ nội bộ.** `blockedReason()` trong `lib/outbound-url.ts:59`
   **chạy được trong trình duyệt** — chính file đó mở đầu bằng *"Do NOT import
   `server-only` here"*. Nên extension import lại đúng hàm đó, không viết bản thứ
   hai. Không có nó, extension trở thành công cụ quét mạng LAN của chính khách.

`assertFetchableUrl()` (§7.1) vẫn chạy ở worker như cũ. Hai hàm, hai môi trường,
một luật — đúng như file đó được viết ra để làm.

### 12.7 Những gì tính năng này KHÔNG làm

Dùng Chrome thật của khách khiến ít gặp CAPTCHA hơn. Đó là **hệ quả**, không phải
mục tiêu, và ranh giới không đổi so với §7.2 và §7.3:

- **robots.txt vẫn từ chối cứng**, kiểm tra ở server trước khi phát bất kỳ lệnh nào.
- **CAPTCHA vẫn dừng sạch.** Gặp trang chặn thì báo và dừng.
- **Không có bất kỳ tính năng chống phát hiện nào**: không stealth plugin, không
  giả fingerprint, không xoay user-agent, không giải CAPTCHA.

Nếu về sau có ai đề nghị thêm những thứ đó, đây là chỗ đã ghi sẵn câu trả lời:
không.

### 12.8 Rủi ro thật của MV3: service worker bị ngắt

Chrome ngắt service worker của extension khi rảnh. Một stream SSE đang mở **có**
kéo dài tuổi thọ của nó ở các bản Chrome gần đây, nhưng **phải đo, không được tin
sẵn** — đây đúng là loại giả định mà repo này quen ghi *"Verified, not assumed"*.

Giảm thiểu, theo thứ tự:

- `chrome.alarms` mỗi 30 giây để đánh thức lại.
- Extension **tự nối lại** với backoff khi stream đứt.
- Worker coi việc mất thiết bị là chuyện bình thường: lệnh quá hạn thì thử lại một
  lần, vẫn hỏng thì dừng run **có báo**.
- Popup của extension hiện trạng thái kết nối, để khách nhìn thấy khi nó rớt.

**Việc phải đo trước khi build tiếp**: một crawl 20 phút có giữ được service worker
sống không. Nếu không, phương án dự phòng là extension mở một **offscreen document**
— thứ có vòng đời dài hơn hẳn service worker.

### 12.9 macOS và Windows

Extension giống hệt nhau trên hai hệ điều hành: cùng một bản build, cùng một cách
cài, không ký số, không notarize, không cần terminal. Đây chính là lý do phương án
này thắng bridge agent — agent đóng gói sẽ cần notarize của Apple (tài khoản
99$/năm) và nên ký trên Windows, lặp lại mỗi lần phát hành.

`platform` trong `crawl_devices` chỉ để hiển thị và hỗ trợ, không rẽ nhánh logic.

### 12.10 Chọn đường đi ở form crawl

Job crawl thêm một tuỳ chọn `transport`:

- `server` — worker tự fetch từ VPS. Mặc định, nhanh nhất, không cần cài gì.
- `browser` — đi qua Chrome của khách.

Chọn `browser` mà không có thiết bị nào đang online thì **fail ngay lúc tạo run**,
kèm hướng dẫn nối máy, chứ không xếp hàng rồi treo.
