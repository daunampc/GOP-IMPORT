# Việc tiếp theo: tự thử lại lỗi tạm thời, và năm việc nhỏ

Tài liệu này là **prompt bàn giao**. Dán toàn bộ vào một session Claude Code mới.

Viết bằng tiếng Việt vì người duyệt là chủ sản phẩm. **Code, comment trong code và
toàn bộ giao diện vẫn là tiếng Anh** — đây là quyết định đã chốt, không phải điều
còn bỏ ngỏ.

---

## Tóm tắt: còn lại những gì

Ba đợt trước đã xong: plugin cập nhật sản phẩm (§2.1–2.3), ba chế độ ghi khi import
(§2.4), và màn hình `/products` (§2.5). Còn lại:

1. **§2.6 — tự thử lại lỗi tạm thời ở mức batch.** Việc chính, và là việc duy nhất
   còn lại trong bốn việc ban đầu.
2. **§6 C1–C4** — bốn việc nhỏ: giảm lane khi site chậm, hẹn giờ lặp lại, thông báo
   khi run xong, kiểm ảnh trước khi chạy.
3. **`images`** — quyết định còn treo. Xem §5 dưới đây; **cần chủ sản phẩm trả lời
   trước khi làm.**

---

## 0. Đọc trước khi viết bất kỳ dòng code nào

Thứ tự này có lý do — mỗi file sau dựa vào file trước.

### Bắt buộc

- `clients/manager-push-product-wordpress/AGENTS.md` — **đây không phải Next.js bạn
  biết.** Next 16.3.1. Đọc guide tương ứng trong
  `clients/manager-push-product-wordpress/node_modules/next/dist/docs/` trước khi
  viết code: route handlers, async `params`/`searchParams`, và helper toàn cục
  `RouteContext<"/api/...">` / `PageProps<"/...">` do `next typegen` sinh ra.
- `clients/manager-push-product-wordpress/README.md` — hợp đồng dữ liệu, mô hình tài
  khoản, vì sao đóng trình duyệt không dừng run, và **mục Status** ở cuối. Phần
  "Not verified" là thật thà và đáng tin.
- `docs/superpowers/specs/2026-08-18-product-update-confirmation-design.md` —
  **thiết kế câu xác nhận đã được chủ sản phẩm chốt.** Ngưỡng gõ chữ, mức xác nhận,
  danh sách trường không cho ghi. Đừng thiết kế lại.
- `docs/superpowers/specs/2026-08-17-csv-detect-logs-license-design.md` — spec của
  đợt trước nữa, kèm **hai đính chính nó tự làm về chính nó**. Đọc hai đính chính
  đó; chúng nói về bẫy trong repo này.

### Code phải đọc trước khi sửa

- `lib/jobs.ts` — queue, trạng thái run, `attempts: 1`, bản ghi cancel, `RunResult`.
- `worker/index.ts` — **file quan trọng nhất cho §2.6.** `runBatches()` là engine
  dùng chung; `runImport`, `runWriteMode`, `runEdit`, `runPurge` cắm vào nó.
- `lib/gop-client.ts` — giao thức dây, `GopApiError`, `GopAbortError`, deadline mỗi
  request, `request_timeout`.
- `lib/job-log.ts` — `logJob()`, các `stage`.
- `lib/ownership.ts`, `lib/view.ts`, `lib/limits.ts` — **ba thứ mọi route mới phải
  đi qua. Không thương lượng.**
- Plugin: `/Volumes/Personal/Company/GPM_toshstack/` — `index.php` (bảng dispatch 9
  route), `src/Import/ProductUpdater.php`, `src/Import/ProductDeleter.php`.

---

## 1. Sự thật đo được — trạng thái HIỆN TẠI, đã kiểm bằng cách chạy. Đừng suy lại.

### 1.1 Plugin đang ở 3.2.0 và có 9 route

Từ `dispatch()` trong `index.php`:

```
GET  /health
GET  /terms/{taxonomy}
POST /products/batch
POST /products/lookup
POST /products/exists                  ← thêm ở đợt trước
POST /products/update                  ← thêm ở đợt trước
POST /products/delete
POST /images/fetch
POST /maintenance/clear-transients
POST /maintenance/recalculate-prices   ← thêm ở đợt trước
```

Mọi thứ khác trả 404 `unknown_route`.

**Plugin CẬP NHẬT ĐƯỢC sản phẩm rồi.** `src/Import/ProductUpdater.php`:

- Chỉ ghi trường **CÓ MẶT** trong request. `array_key_exists` là thứ phân biệt, không
  phải `isset`. Ba trạng thái: vắng khoá = không chạm; `""` = xoá có chủ ý; `null` =
  **từ chối dòng** (`null_field`).
- Khớp theo thứ tự cụ-thể-nhất-trước: `product_id` → `idempotency_key` → `sku`.
  SKU trùng nhiều sản phẩm là **lỗi** cho dòng đó (`ambiguous_sku`, có nêu id), không
  chạm sản phẩm nào.
- `_price` là trường **dẫn xuất**, tính lại từ `regular_price`/`sale_price`.
- Ghi lại `wc_product_meta_lookup`, tính lại min/max của sản phẩm cha bằng aggregate,
  xoá transient theo id bằng `DELETE` chính xác.
- `MAX_UPDATE_BATCH = 50`, `MAX_EXISTS_SKUS = 1000`.
- **KHÔNG** ghi: `images`, `type`, `attributes`, `variations` (cả bộ). Gửi vào là
  **lỗi** `unsupported_field`, không phải bỏ qua im lặng.

`POST /products/lookup` giờ nhận thêm `name` và `status` (thu hẹp **trên** một trong
bốn selection, không thay thế nó), và `ProductSummary` mang thêm `regular_price`,
`sale_price`, `stock`, `manage_stock`.

**Lỗi transient cũ đã sửa:** `clear_woocommeerce_transients(0)` chạy nhánh sai và
xoá mọi option kết thúc bằng `_0`. Cả hai chỗ gọi giờ truyền `(NULL)`.

### 1.2 App đã có ba chế độ ghi

`lib/import-options.ts` → `writeMode: "skip" | "create_or_update" | "update_only"`,
**mặc định `skip`** nên không tài khoản/preset/options cũ nào đổi hành vi.

`worker/index.ts` → `runWriteMode()` hỏi `/products/exists` **theo từng batch** (không
phải một lần đầu run: một run 14.000 sản phẩm chạy nhiều giờ, câu trả lời phút 0 sẽ cũ
ở giờ thứ 3), rồi chia batch thành nửa update và nửa create.

`lib/product-update.ts` → `toProductUpdate()`. **Đọc comment dài trong file này trước
khi sửa gì liên quan.** Nó là thứ ngăn một tai hoạ: `Product` dựng cho import mang
`""` cho mọi cột file không có, và `""` trên route update nghĩa là "xoá có chủ ý".

`app/api/import/exists/route.ts` + `app/(app)/import/existing-check.tsx` → preview trả
lời **trước khi** chạy; ở hai chế độ ghi, nút Start bị chặn tới khi đã đọc site.

### 1.3 Màn hình `/products` đã có

`app/(app)/products/{page,products-view,edit-drawer,bulk-panel}.tsx`, và bốn route:
`/api/products/lookup`, `/api/products/update`, `/api/products/bulk` (hai action
`preview`/`run`), cộng xoá qua `/api/purge` với `selection.kind = "ids"`.

- Sửa **một** sản phẩm: drawer, cũ cạnh mới, đồng bộ, không tạo run.
- Sửa **hàng loạt**: là một **run** (`kind: "update"`), qua queue/worker/log/Cancel/Stop.
- Xác nhận: gõ `UPDATE` khi **>20 sản phẩm HOẶC mọi thay đổi tương đối** (đã chốt với
  chủ sản phẩm). Kiểm lại ở route handler.
- Giá về **≤ 0** thì **TỪ CHỐI cả dòng**, không kẹp về 0.
- `lib/plugin-support.ts` → `REQUIRED_PLUGIN_VERSION = "3.2.0"`. Site cũ hơn bị **từ
  chối**, không suy giảm — vì plugin cũ **bỏ qua** khoá lọc lạ chứ không từ chối, nên
  tìm kiếm sẽ lặng lẽ trả về cả danh mục.

### 1.4 Switch mới theo tài khoản

`account_limit.product_edit_enabled`. **Vắng nghĩa là được phép**, như mọi switch khác.
`productEditVerdict()` / `checkProductEdit()` trong `lib/limits.ts`, kiểm cả
`maxProductsPerRun` và `maxThreads`.

### 1.5 Cột mới trên `job_result`

- `changed jsonb` — `{field: {from, to}}`, chỉ trường **thật sự** khác. Đây là **bản
  ghi duy nhất** của giá cũ: site đã ghi đè và không chỗ nào khác trong app giữ lại.
- `action text` (`created` | `updated`, null = created). Không phải sổ sách:
  `createdProductIds()` loại `updated` ra, vì `/remove` có lựa chọn "Everything one
  import run created" và nếu không loại thì nó sẽ **xoá danh mục sẵn có của khách**.

Migration `0010`, `0011`, `0012` — **đã sinh VÀ đã áp**.

### 1.6 Run vẫn KHÔNG tự thử lại — đây là việc còn lại

`lib/jobs.ts`, `defaultJobOptions.attempts: 1`. Một `request_timeout` — lỗi tạm thời
hay gặp nhất, và đợt trước đã làm cho nó **quy được trách nhiệm** — vẫn cần người bấm
"Resend the failures".

### 1.7 Ngưỡng lookup, thật và giữ nguyên

`MAX_LOOKUP_PAGE = 500` (summary), `MAX_LOOKUP_IDS = 100_000` (`ids_only`),
`MAX_BATCH_SIZE = MAX_DELETE_BATCH = MAX_UPDATE_BATCH = 50`.

---

## 2. Việc phải làm

### 2.1 §2.6 — tự thử lại lỗi tạm thời ở MỨC BATCH

Việc chính. Chỗ sửa là `runBatches()` trong `worker/index.ts` — engine dùng chung, nên
làm một lần là cả bốn loại run (import, write-mode, bulk edit, purge) đều có.

**Thử lại batch, KHÔNG phải run.** 2–3 lần, có backoff.

**Chỉ với lỗi tạm thời.** `request_timeout` và lỗi tầng mạng. **Tuyệt đối không** với
lỗi plugin như `missing_name`, `ambiguous_sku`, `slug_taken`, `not_on_site` — những cái
đó sẽ lỗi y hệt mãi mãi, và thử lại chỉ làm run chậm gấp ba rồi thất bại như cũ.
`describeFailure()` đã tách mã lỗi ra sẵn; dùng nó, đừng phân loại theo chuỗi thông báo.

**`GopAbortError` KHÔNG BAO GIỜ được thử lại.** Đó là người vận hành bấm Stop. Nhánh
bắt nó trong `runBatches` phải `return` ngay như hiện tại — nếu thử lại, Stop sẽ mất
tác dụng đúng lúc nó quan trọng nhất.

**Ghi log MỌI lần thử.** "nó chạy được ở lần thứ ba" phải nhìn thấy được, chứ không
trông như chạy được ngay lần đầu. Dùng `stage: "batch"`, `level: "warn"` cho lần thử
lại. Đây là yêu cầu rõ trong §2.6 và nó là phần dễ bỏ nhất.

**Idempotency key làm việc này an toàn** cho import. Với `runWriteMode` và `runEdit`
thì an toàn vì lý do khác và tốt hơn: `runEdit` gửi **giá trị tuyệt đối**, nên gửi hai
lần ghi cùng một số hai lần; `runWriteMode` hỏi lại `/products/exists` nên lần thử
thứ hai thấy sản phẩm đã tồn tại và **cập nhật** thay vì tạo trùng.

**KHÔNG đổi `attempts: 1` trên queue job.** Thử lại cả một run là việc khác và tệ
hơn; comment ở chỗ đặt giá trị đó giải thích tại sao, và lý do vẫn còn đúng.

**Cần kiểm tra kỹ:** `runBatches` chạy nhiều lane song song và mỗi lane đọc bản ghi
cancel **giữa các batch**. Một batch đang trong vòng thử lại thì đang ở *trong* một
lần lặp. Phải kiểm bản ghi cancel **giữa các lần thử lại** nữa, không thì bấm Cancel
sẽ phải chờ hết cả chuỗi backoff.

**Test bắt buộc** (§5 yêu cầu test không thể xanh trước khi có tính năng):
- Một batch `request_timeout` rồi thành công ở lần thử thứ hai → run **completed**,
  và log có dòng cho **cả hai** lần.
- Một batch lỗi `missing_name` → **không** thử lại (đếm số request, hoặc đếm dòng log).
- Bấm Stop giữa lúc đang backoff → dừng ngay, không chờ hết chuỗi.
- Hết lượt thử → ghi `request_timeout` như hiện tại, không phải mã khác.
- `tests/cancel.sh` là chỗ duy nhất tái hiện được site không bao giờ trả lời — dùng nó.

### 2.2 §6 — bốn việc nhỏ, làm sau §2.6

| | Việc | Vì sao |
|---|---|---|
| C1 | Giảm lane khi site chậm | 32 lane × 50 sản phẩm có thể làm sập một shop nhỏ. `elapsed_ms` mỗi batch đã được ghi sẵn trong `job_batch` — đủ để tự lùi thay vì bắt người vận hành đoán |
| C2 | Hẹn giờ lặp lại | Hẹn giờ hiện chỉ nổ một lần. Đồng bộ giá hằng ngày cần lặp, và `repeat` của BullMQ đã có sẵn |
| C3 | Thông báo khi run xong | Email hoặc webhook. Run 14.000 sản phẩm chạy nhiều giờ, hiện phải ngồi trông màn hình |
| C4 | Kiểm ảnh trước khi chạy | URL ảnh chết chỉ phát hiện được giữa lúc import. Một HEAD cho mỗi URL khác nhau ở bước preview là bắt được |

**C2 có một cái bẫy thật:** `JobStatus` cố tình giữ đúng năm thành viên gốc và
"scheduled" được **suy ra** từ `scheduled_for` — chính vì thêm thành viên enum sẽ làm
mọi màn hình switch theo status phải xử lý hoặc vỡ lúc chạy. Hẹn giờ lặp lại đừng đi
ngược quyết định đó. Đọc mục "Scheduled runs" trong README trước khi thiết kế.

---

## 3. Quyết định đã chốt — ĐỪNG bàn lại

- **Thiết kế câu xác nhận đã được chủ sản phẩm đồng ý.** Ngưỡng: gõ `UPDATE` khi >20
  sản phẩm **hoặc** mọi thay đổi tương đối. Preview hiện 20 dòng đầy đủ + đếm phần
  còn lại + ba con số tính trên **toàn bộ** selection. Giá về ≤0 thì từ chối, không kẹp.
- **Partial update không phải lựa chọn.** Route ghi đè trường vắng mặt bằng giá trị
  rỗng là **không chấp nhận được**, dù có đơn giản hơn bao nhiêu.
- **Sửa hàng loạt là một run.** Qua queue, worker, log, Cancel/Stop. Không phải vòng
  lặp trong route handler.
- **Một filter không bao giờ là thứ được thực thi.** Filter ra danh sách, người vận
  hành đọc danh sách, run dựng từ danh sách. `EditItem` mang **giá trị tuyệt đối** đã
  giải ra lúc preview — không phải quy tắc để áp lại. Điều này cũng là thứ làm việc
  gửi lại an toàn: một "−10%" lưu lại rồi gửi lại sẽ trừ thêm 10% nữa.
- **`images` không sửa được, có chủ ý** — xem §5.
- **Route mới không đổi route cũ.** Header `X-TSD-*` và tiền tố `tsd_` giữ nguyên.
- **Ownership và mô hình tài khoản không đổi.** Mọi route mới qua `apiRequireOwned`
  hoặc `apiRequireView`; thành viên chạm dữ liệu tài khoản khác trả **404, không bao
  giờ 403**.
- **Switch theo tài khoản kiểm ở route handler**, không phải chỉ ẩn ở giao diện.
  **Vắng nghĩa là được phép.**
- **Design system giữ nguyên.** Không class màu thô; câu này phải rỗng:
  ```bash
  grep -rnE '\b(bg|text|border)-(slate|gray|red|blue|emerald|amber)-[0-9]{2,3}\b' app components
  ```
- **Đừng "sửa" run đang mắc ở "Cancelling" trên database dev.** Nó do chủ sản phẩm tự
  import rồi dừng; đó là dữ liệu, không phải lỗi.

---

## 4. Bẫy đã gặp — mỗi cái đều mất thời gian thật

### 4.1 Môi trường

**Không có Node.js và không có PHP trên máy này. Chỉ có Docker.**

Thư mục làm việc cho mọi thứ:
`/Volumes/Personal/Company/toshstack.dev/clients/manager-push-product-wordpress`

**Dùng đường dẫn TUYỆT ĐỐI trong mọi câu lệnh.** Shell mở ở gốc repo, không phải ở
app, và nó không giữ cwd giữa các lệnh một cách đáng tin. `tsc` chạy từ gốc repo sẽ in
help rồi exit 1 — và nếu pipe qua `grep -E "error"` thì trong help có chữ "error", bạn
sẽ báo build sạch cho một lần build chưa từng chạy. **Chuyện này đã xảy ra.**

```bash
APP=/Volumes/Personal/Company/toshstack.dev/clients/manager-push-product-wordpress
docker run --rm -v "$APP":/app -v tsd-nm:/app/node_modules -w /app node:22-alpine \
  sh -c './node_modules/.bin/next typegen &&
          ./node_modules/.bin/tsc --noEmit &&
          ./node_modules/.bin/eslint &&
          ./node_modules/.bin/next build'
```

**Đừng đẩy `next typegen` vào `/dev/null`** — nó che một lỗi thật, và đã che suốt một
session.

Migration:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$APP":/app -v tsd-nm:/app/node_modules -w /app --env-file "$APP/.env" \
  -e DB_HOST=host.docker.internal node:22-alpine \
  sh -c './node_modules/.bin/drizzle-kit generate && ./node_modules/.bin/tsx db/migrate.ts'
```

**Sinh migration không phải là áp migration.** Sinh rồi quên chạy `db/migrate.ts` thì
app trả 500 `column … does not exist`, hiện ra trong trình duyệt là trang trắng và
React error #441. **Chuyện này đã xảy ra.**

**`gop-web` và `gop-worker` phải TẠO LẠI, không bao giờ `docker restart`.** `restart`
lỗi với `TransformError` của esbuild về binary theo nền tảng.

**VÀ — bẫy này bắt được tôi ở đợt vừa rồi, tệ hơn:** `gop-worker` chạy
`tsx worker/index.ts`, và **tsx không hot-reload**. Một worker đã chạy vài giờ đang
dùng code **cũ**. Của tôi xử lý một run `kind: "update"` như import và **tạo 2 sản
phẩm mới** thay vì sửa — trong lúc màn hình vẫn báo "Updated" vì badge đọc `job.kind`.
Sau **mọi** lần sửa `worker/`, tạo lại `gop-worker` trước khi tin bất cứ thứ gì bạn
thấy trong trình duyệt.

```bash
cd "$APP"
docker rm -f gop-worker
docker run -d --name gop-worker --add-host=host.docker.internal:host-gateway \
  -v "$PWD":/app -v tsd-nm:/app/node_modules -w /app --env-file "$PWD/.env" \
  -e DB_HOST=host.docker.internal -e REDIS_URL=redis://host.docker.internal:6379 \
  node:22-alpine ./node_modules/.bin/tsx worker/index.ts

docker rm -f gop-web
docker run -d --name gop-web --add-host=host.docker.internal:host-gateway \
  -v "$PWD":/app -v tsd-nm:/app/node_modules -w /app --env-file "$PWD/.env" \
  -e BETTER_AUTH_URL=http://localhost:3100 -e NODE_ENV=production \
  -e DB_HOST=host.docker.internal -e REDIS_URL=redis://host.docker.internal:6379 \
  -e GOP_PLUGIN_VERSION=3.1.0 -p 3100:3000 node:22-alpine ./node_modules/.bin/next start
```

`gop-web` chạy `next start` (production), nên nó phục vụ `.next` đã build. Xoá `.next`
rồi build lại **ở container khác** thì tiến trình đang chạy vẫn giữ manifest cũ và
route mới trả **404**. Tạo lại.

Plugin PHP là checkout riêng ở `/Volumes/Personal/Company/GPM_toshstack/`, **hiện
3.2.0**, có `./tests/integration.sh` (81/81), `./tests/run.php` (35/35),
`./tests/wordpress-e2e.sh` và `./build.sh`. Tên thư mục khi deploy là `gop-import`.
`build.sh` **từ chối** nếu `gop-import.php` và `version.txt` lệch phiên bản — nhớ sửa
cả hai.

Lint PHP:
```bash
cd /Volumes/Personal/Company/GPM_toshstack
for f in $(find . -name "*.php" -not -path "./dist/*"); do
  docker run --rm -v "$PWD":/app -w /app php:8.2-cli php -l "$f" | grep -v "^No syntax errors"
done
```

### 4.2 TypeScript và React

- `tsx -e` compile ra CJS nên **không dùng được top-level await**. Bất cứ gì chạm
  database phải là một **FILE**. Và trong file đó, import phải là `"./db"` chứ không
  phải `"../db"` — script nằm ở gốc `/app`. Xoá file tạm theo cách chịu được lệnh bị
  timeout: một `.tmp-*.ts` còn sót lại sẽ làm lint đỏ.
- `react-hooks/purity` là **error**. `Date.now()` hoặc `new Date()` trong thân render
  làm vỡ build, kể cả trong `hydrated &&`. Đưa việc đọc đồng hồ vào helper thuần ở
  module khác (như `formatRelative`, `isWithin` trong `lib/format.ts`) hoặc vào
  event handler.
- `react-hooks/set-state-in-effect` là **error**. Hãy suy ra giá trị. Đây là lý do
  màn hình `/products` và panel "What is already on the site" dùng **nút** thay vì fetch
  khi mount — và nó cũng đúng với hình dạng của màn hình `/remove` sẵn có.
- Hydration error #418: bất cứ gì từ "bây giờ" không được render lúc SSR. Dùng
  `DateTime`, `RelativeTime`, `ElapsedTime`, `useHydrated` trong
  `components/ui/client-time.tsx`. Một `.next` cũ cũng tạo ra #418 giả — build sạch
  trước khi tin một cái.
- `ioredis`, `bullmq`, `postgres` **không bao giờ** được tới Client Component. Helper
  thuần mà client cần thì nằm ở `lib/store-links.ts`, `lib/plugin-version.ts`,
  `lib/purge-options.ts`, `lib/job-display.ts`, `lib/import-options.ts`,
  `lib/edit-options.ts`, `lib/product-update.ts`, `lib/sources/csv-dialect.ts`.
  `Can't resolve 'net'` nghĩa là một client component đã import module server.
  **`import type` bị xoá lúc compile và luôn an toàn** — một spec trước đã nói sai
  điều này và phải tự đính chính. Chỉ import **giá trị** mới quan trọng.
- `import "server-only"` throw ngoài RSC. Nó có trong `lib/preview.ts`,
  `lib/ownership.ts`, `lib/view.ts`, `lib/audit.ts`, `lib/build-products.ts`,
  `lib/plugin-support.ts`. Script Node thuần không import được — chèn hàng bằng
  drizzle trực tiếp, như `tests/isolation.ts` làm với preview.
- Xoá `.next` làm typecheck vỡ tới khi `next typegen` chạy lại.
- `pg` không chạy dưới Turbopack ở đây. Driver là `postgres.js`.
- `EmptyState` **bắt buộc** có prop `action`.

**Bẫy mới, và là bẫy đắt nhất về mặt thiết kế:**

Thêm thành viên vào `JobKind` **KHÔNG sinh ra một lỗi biên dịch nào.** Mọi màn hình
viết `kind === "purge" ? … : …` và coi phần còn lại là import — nên một bulk edit lặng
lẽ được gán nhãn "Import", và thống kê in **"Created 2"** lên những sản phẩm nó chỉ
sửa giá. Phải tìm bằng grep. Cách sửa là `JOB_KIND_LABELS: Record<JobKind, string>`
trong `lib/job-display.ts` — record khoá theo union **thì** vỡ build khi thêm thành
viên. Thêm thành viên thứ tư thì thêm vào record đó, badge sẽ theo.

### 4.3 Test

- `better-auth` rate-limit đăng nhập và trả 429 ở cuối một suite dài. `POST
  /api/register` **đã** set cookie session, nên tài khoản vừa đăng ký là đã đăng nhập
  — đừng gọi sign-in thêm.
- Không có body trên GET trong test client; undici từ chối thẳng.
- `drizzle-kit` cần TTY cho prompt đổi tên: một migration vừa drop vừa add cột trong
  cùng một bảng **không sinh được** ở chế độ headless. Tách ra. Và **đọc SQL sinh ra**
  — nó từng phát ra composite primary key trước cả cột nó nêu tên.
- `zsh` không word-split biến không quote. Dựng flag docker thành array.
- **`applyOptions()` sinh hậu tố slug random MỚI mỗi lần gọi**, và idempotency key băm
  từ slug — nên hai lần gọi cho ra **key khác nhau** và không dedup được. Đây là hành
  vi đã ghi nhận ("preview là hợp đồng": một lần đọc file là một bộ key), và app thật
  cũng không đọc lại vì Start trỏ vào preview đã lưu. Trong test, **tái dùng cùng
  array đã stage**, đừng gọi `applyOptions` hai lần. Tôi đã viết sai một test vì điều
  này.
- **`tests/cancel.sh`: `phase()` cần `"${reuse[@]}"`** để truyền `ACCOUNT_ALICE` và
  `STORE_ID`. Thiếu là `created_by` null → not-null violation.
- **Trong `tests/integration.php`, mỗi test phải có fixture RIÊNG.** Test nào sửa một
  sản phẩm dùng chung sẽ làm đỏ test khác chạy sau, và lỗi hiện ra ở test thứ hai chứ
  không phải ở test gây ra. Tôi bị hai lần. Cũng kiểm SKU đã dùng chưa trước khi thêm
  fixture — `TSD-SLUG-1` đã có sẵn ở dòng 288 và test của tôi tạo ra SKU trùng, làm
  `ambiguous_sku` nổ lên **đúng**.
- **`meta($db, $id, $key)` trả `null`, không phải `""`,** khi không có hàng meta. Sản
  phẩm không có SKU thì không có hàng `_sku` nào cả.

### 4.4 SQL / PHP

- **`virtual` là từ khoá dành riêng trong MySQL 8.** `SET sku = ?, virtual = ?` là lỗi
  cú pháp. Backtick mọi tên cột trong câu lệnh chạm `wc_product_meta_lookup`.
- `affected_rows` **không** dùng được để chọn giữa UPDATE và INSERT: nó là 0 cả khi
  không khớp hàng nào **và** khi giá trị ghi vào y hệt giá trị đang có. Đọc sự tồn tại
  trước. `ProductUpdater::writeMeta()` làm đúng thế.
- **PHP không có labeled block.** `void: { ... }` là cú pháp không hợp lệ.
- Đừng dùng hàm stored function thừa hưởng `tsd_update_product`. Nó ghi cùng một giá
  trị vào cả `_regular_price` và `_price`, không chạm `wc_product_meta_lookup`, cộng
  count cho category mới mà không trừ category cũ, và không có đường xử lý biến thể.
  `ProductUpdater` viết bằng PHP vì lý do đó — cùng lý do `ProductDeleter` từ chối
  `delete_product_by_id`.

### 4.5 Luật thật thà mà codebase này tự giữ

Vi phạm bất kỳ điều nào thì thay đổi là **sai**, dù nó chạy tốt đến đâu:

- **Không bao giờ cắt một thông báo lỗi mà người ta phải đọc.** `text` của Postgres
  không có giới hạn độ dài.
- **Một filter không bao giờ là thứ được thực thi.**
- **Từ chối, đừng lặng lẽ cắt gọt.** Run vượt ngưỡng thì **từ chối kèm thông báo**,
  không cắt cho vừa rồi báo thành công.
- **Nói ra điều không bảo đảm được.** Câu xác nhận Stop thừa nhận site có thể đang giữ
  sản phẩm mà bảng kết quả không liệt kê. `EDIT_CANCEL_WARNING` thừa nhận cancel một
  lần sửa giá **không** đưa giá cũ về.
- **Không bao giờ trình bày một trang như thể là tất cả.** Luôn nói cả hai con số: tải
  bao nhiêu và filter khớp bao nhiêu trên site.

---

## 5. Câu hỏi CÒN TREO cho chủ sản phẩm — hỏi trước khi làm `images`

Ở đợt trước, câu hỏi về danh sách trường cho ghi nhận được câu trả lời **tự mâu
thuẫn**: chủ sản phẩm tick cả "Đúng như đề xuất — không thiếu gì" **và** cả ba mục
thêm (`images`, `sku`, `slug`).

`sku` và `slug` **đã làm** — nhỏ, luật an toàn rõ ràng, có test:
- `sku` chỉ ghi được khi dòng được khớp bằng `product_id` hoặc `idempotency_key`; SKU
  đã thuộc sản phẩm khác thì **từ chối** (`sku_taken`).
- `slug` đã thuộc sản phẩm khác thì **từ chối** (`slug_taken`), không tự thêm hậu tố —
  thêm hậu tố im lặng nghĩa là sản phẩm không nằm ở URL người ta yêu cầu.

**`images` chưa làm.** Nó là việc lớn hơn nhiều và cần quyết định:

Thay gallery nghĩa là tạo và xoá attachment post, `_thumbnail_id`,
`_product_image_gallery`, `fifu_image_url*` (index dịch chuyển khi danh sách đổi),
`_wp_attached_file`, `_wp_attachment_metadata` — **và xoá file khỏi ổ đĩa**. Nó đổi id
ảnh. Nó cũng cần tích hợp với `stageImages()` (S3 / copy vào site).

Bản không phá hoại: tạo attachment cho URL chưa có, xoá hàng attachment cho URL không
còn trong danh sách, giữ nguyên id cho URL trùng khớp. Vẫn cần câu xác nhận riêng, vì
nó xoá file.

**Hỏi chủ sản phẩm:**
1. `images` có làm trong đợt này không, hay tách hẳn thành một việc riêng?
2. Nếu làm: xoá file ảnh cũ khỏi `uploads` luôn, hay chỉ bỏ liên kết và để file lại?
   (Màn hình xoá có switch "Image files" cho đúng câu hỏi này.)

---

## 6. Kiểm chứng

Các suite đang xanh phải **giữ nguyên xanh**, và thay đổi mới cần test **không thể
xanh trước khi có nó**.

Baseline hiện tại — mọi con số dưới đây đã đo bằng cách chạy, không phải nhớ:

```bash
# App — build sạch từ .next đã xoá
APP=/Volumes/Personal/Company/toshstack.dev/clients/manager-push-product-wordpress
rm -rf "$APP/.next"
docker run --rm -v "$APP":/app -v tsd-nm:/app/node_modules -w /app node:22-alpine \
  sh -c './node_modules/.bin/next typegen && ./node_modules/.bin/tsc --noEmit &&
          ./node_modules/.bin/eslint && ./node_modules/.bin/next build'

cd "$APP"
./tests/e2e.sh         # 83/83
./tests/isolation.sh   # 127/127
./tests/cancel.sh      # 73 assertion, 0 lỗi, exit 0

grep -rnE '\b(bg|text|border)-(slate|gray|red|blue|emerald|amber)-[0-9]{2,3}\b' app components  # phải rỗng

# Plugin
cd /Volumes/Personal/Company/GPM_toshstack
docker run --rm -v "$PWD":/app -w /app php:8.2-cli php tests/run.php   # 35/35
./tests/integration.sh                                                 # 81/81
./build.sh                                                             # dist/gop-import-3.2.0.zip
```

`./tests/cancel.sh` in "Passed: 13" ở phase cuối — đó là bộ đếm của phase đó, không
phải tổng. Đếm tổng bằng `grep -cE '^  ok '`.

Giữ tính chất ranh-giới-tiến-trình trong e2e: tiến trình xếp job vào queue **thoát**
trước khi worker khởi động.

**Chứng minh test có "răng" bằng đột biến, đừng chứng minh bằng cách đọc.** Tôi làm
việc này cho partial update và nó đáng: tắt phần ghi giá → 12 test đỏ; cho các trường
vắng mặt ghi thành rỗng (đúng cách làm đơn giản mà route này từ chối) → test
partial-update đỏ. Làm điều tương đương cho §2.6: nếu tắt logic thử lại mà không test
nào đỏ, thì test đang không kiểm gì.

**Báo cáo thật thà:** tách rõ cái gì bạn đã kiểm và kiểm bằng cách nào, khỏi cái gì
bạn không kiểm được. Đừng gọi là xong với thứ chưa từng chạy.

### Đi bộ trên trình duyệt

`/products` cần một site chạy plugin **3.2.0**, nên các store trên database dev
(3.1.0 và null) sẽ bị **từ chối** — đó là hành vi đúng và cũng đáng xem.

Để đi bộ đường "live", dựng một site thật: MySQL 8 + PHP phục vụ bản copy plugin đã
cấu hình, nạp schema bằng `php tests/integration.php` của plugin, rồi kết nối qua UI.
**Cảnh báo về cổng:** `gop-walk-blackhole` từ một session trước đang giữ **8099**.
Dùng cổng khác (tôi dùng 8098) và đừng xoá container đó — nó không phải của bạn.

Tài khoản trên database dev được tạo trực tiếp trong Postgres nên **không có mật
khẩu**. Tạo tài khoản mới qua route thật:

```bash
J=/tmp/jar.txt
curl -s -c $J -X POST http://localhost:3100/api/register -H 'Content-Type: application/json' \
  -d '{"name":"Walk","email":"walk-XX@demo.test","password":"WalkPass!2026"}'
curl -s -b $J -c $J -X POST http://localhost:3100/api/license/activate \
  -H 'Content-Type: application/json' -d '{"key":"<một key chưa dùng>"}'
```

Có sẵn khoảng 37 licence key trong bảng `license_key`, một số chưa activate
(`activated_by IS NULL`).

Trong trình duyệt, các input là React controlled nên `form_input` đôi khi không ăn.
Cách chắc chắn:

```js
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(el, 'giá trị');
el.dispatchEvent(new Event('input', { bubbles: true }));
```

Đi bộ **cả hai theme**, với một tài khoản khách và một tài khoản admin. Console phải
sạch — không lỗi ứng dụng, không cảnh báo hydration. Lỗi
`ERR_INCOMPLETE_CHUNKED_ENCODING` trên `/api/jobs/stream` khi bạn điều hướng giữa lúc
stream đang mở là hiện tượng của trình duyệt, không phải lỗi ứng dụng.

---

## 7. Cách làm việc

Làm theo từng bước và **dừng lại báo cáo ngắn giữa các bước**. Quyết định thường thì
tự quyết và nói ra mình đã chọn gì.

Thứ tự đề nghị:

1. **§2.6 — retry theo batch** trong `runBatches()`. Một chỗ sửa, bốn loại run được
   lợi. → *dừng, báo cáo*
2. **Hỏi về `images`** (§5) — hỏi sớm, vì nó quyết định có phải làm việc lớn hay không.
3. **§6 C1** (giảm lane) và **C4** (kiểm ảnh) — hai cái này độc lập và nhỏ.
   → *dừng, báo cáo*
4. **§6 C3** (thông báo) rồi **C2** (hẹn giờ lặp lại). C2 để cuối vì nó chạm mô hình
   trạng thái run, chỗ đã có một quyết định thiết kế phải tôn trọng.

Trước khi sửa `worker/`, nhớ: **tạo lại `gop-worker`**, không thì bạn đang test code cũ.
