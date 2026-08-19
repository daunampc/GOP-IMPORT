# Nhận diện định dạng CSV, logs khi import, và bản quyền theo hạn dùng

Ngày: 2026-08-17

Tài liệu này viết bằng tiếng Việt vì người duyệt nó là chủ sản phẩm. **Code,
comment trong code và toàn bộ giao diện vẫn là tiếng Anh** theo đúng quy ước hiện
tại của repo — đây là quyết định đã chốt, không phải điều còn bỏ ngỏ.

---

## 1. Bối cảnh: hai trong năm yêu cầu đã có sẵn

Kiểm tra code trước khi thiết kế cho thấy hai yêu cầu đã hoạt động đúng rồi. Ghi
lại ở đây để không ai làm lại lần nữa.

| Yêu cầu | Trạng thái thật |
|---|---|
| Vào phải nhập key mới dùng được | **Đã xong.** `lib/session.ts:96` chuyển hướng sang `/activate` khi `!user.activated`; màn hình `app/(auth)/activate` đã có; `isActivated()` được gọi lại ở **mọi request** nên thu hồi key là chặn được ở lần tải trang kế tiếp, không cần đăng xuất ai. |
| Key có hạn sử dụng | **Phần kiểm tra đã xong.** `statusOf()` trả về `expired` khi quá `expires_at`; `activateLicense()` từ chối key hết hạn; `isActivated()` trả `false`; `POST /api/admin/licenses` đã nhận tham số `expiresAt`. **Chỉ thiếu giao diện** — `app/(app)/admin/admin-view.tsx:64` đặt cứng `expiresAt: null`. |

Vậy việc thật sự phải làm gồm bốn thứ, thuộc ba phần độc lập.

---

## 2. Lỗi thật đã tìm ra: dialect bị đặt cứng

`app/(app)/import/import-wizard.tsx:102`

```ts
const [dialect, setDialect] = useState<KnownDialect>("shopify");
```

và dòng 276 luôn gửi giá trị đó lên server:

```ts
form.set("dialect", dialect);
```

Kiểu `KnownDialect` **không có** giá trị nào nghĩa là "tự nhận diện", nên state
này buộc phải mang một định dạng cụ thể, và mặc định là `shopify`. Hệ quả:
`detectDialect()` trong `lib/sources/csv.ts` **chưa bao giờ được chạy trong thực
tế** — mọi file đều bị đọc như Shopify cho đến khi người dùng tự vào bộ ánh xạ
cột và đổi.

Đây chính là hiện tượng đã quan sát được: một file WooCommerce hợp lệ báo lỗi
`Thiếu cột Handle` 24 lần, vì nó bị parser Shopify đọc.

Đây là **lỗi, không phải thiếu tính năng**. Hàm nhận diện đã viết đúng và đã có
sẵn; chỉ là không ai gọi tới.

---

## 3. Phần C — Bản quyền (làm trước, nhỏ nhất, rủi ro thấp nhất)

### 3.1 Đăng ký không cần key

`app/api/register/route.ts` hiện từ chối khi thiếu key:

```ts
if (!isFirstUser && licenseKey === "") {
  return Response.json({ error: "A licence key is required..." }, { status: 400 });
}
```

Bỏ đoạn này. Tài khoản tạo ra ở trạng thái **chưa kích hoạt** (`licenseKeyId` là
null), đăng nhập được nhưng mọi màn hình đều bị đẩy sang `/activate`. Cổng chặn
đó đã có sẵn nên không phải viết gì thêm.

Ô nhập key trong `app/(auth)/sign-up/sign-up-form.tsx` được bỏ khỏi form đăng ký.
Nếu người dùng có key sẵn thì nhập ở màn hình `/activate` ngay sau đó.

**Quy tắc phải giữ:** tài khoản đầu tiên vẫn thành admin và vẫn được tự cấp một
key thật. Nếu bỏ quy tắc này thì không ai tạo được key đầu tiên — cửa khoá mà
chìa để bên trong.

**Điều cần nói rõ:** sau thay đổi này, **bất kỳ ai cũng tạo được tài khoản**. Đó
là hệ quả trực tiếp của yêu cầu, và nó không mở thêm quyền gì — tài khoản chưa
kích hoạt không đọc được, không ghi được, không chạy được gì cả. Nhưng nó có
nghĩa là bảng `user` từ nay có thể chứa tài khoản rác. Không xử lý trong phần
này; nếu sau này cần thì thêm giới hạn theo IP hoặc xác minh email, và đó là một
task riêng.

### 3.2 Hạn dùng tính từ lúc kích hoạt

Thêm **một cột**:

```
license_key.valid_days  integer  NULL
```

Ý nghĩa: `NULL` là không hết hạn; `N` là key sống N ngày **kể từ khi kích hoạt**.

- Khi tạo key: admin chọn "không hết hạn" hoặc N ngày. Lưu vào `valid_days`,
  `expires_at` để nguyên `NULL`.
- Khi kích hoạt: nếu `valid_days` khác null thì đặt
  `expires_at = now() + valid_days ngày`, trong **cùng transaction** với việc gán
  key cho tài khoản.
- `statusOf()`, `isActivated()`, phần từ chối key hết hạn: **không sửa gì**, vì
  tất cả đã đọc `expires_at`.

Vì sao tính từ lúc kích hoạt chứ không từ lúc tạo: admin cần tạo trước một loạt
key để bán, và một key nằm chờ ba tuần thì không được mất ba tuần hạn dùng.

`expires_at` vẫn giữ nguyên và vẫn là nguồn sự thật duy nhất về "khi nào hết
hạn". `valid_days` chỉ là **thời hạn chưa được áp**, và nó trở thành `expires_at`
đúng một lần, tại thời điểm kích hoạt. Hai cột không bao giờ mâu thuẫn vì chỉ một
cột được đọc khi quyết định cho vào hay không.

### 3.3 Giao diện admin

Khi tạo key, thêm ô số ngày cùng một công tắc "không hết hạn". Bảng danh sách key
hiện thêm:

- key chưa dùng có `valid_days`: "còn nguyên · 30 ngày kể từ khi kích hoạt";
- key đang dùng: đếm ngược thời gian còn lại, và cảnh báo khi còn dưới 7 ngày;
- key hết hạn: đã có sẵn trạng thái `expired`.

Đếm ngược lấy mốc từ "bây giờ" nên **phải** dùng các component trong
`components/ui/client-time.tsx`, không được render lúc SSR — đây đúng là cái bẫy
hydration #418 đã gặp ở task trước.

### 3.4 Kiểm chứng phần C

Thêm vào `tests/isolation.sh`, chạy trên server thật:

1. đăng ký **không** key → 201, tài khoản tồn tại nhưng chưa kích hoạt;
2. tài khoản đó gọi mọi route account-scoped → bị chặn, không đọc được gì;
3. kích hoạt bằng key hợp lệ → dùng được bình thường;
4. key có `valid_days` = 1: sau khi kích hoạt, `expires_at` phải nằm trong
   khoảng 1 ngày ± vài giây;
5. đặt `expires_at` về quá khứ → tài khoản **bị khoá lại ngay request kế tiếp**;
6. member không tạo được key (đã có test, giữ nguyên);
7. member không tự sửa được `valid_days` của mình.

---

## 4. Phần A — Nhận diện định dạng ở bước 1

### 4.1 Sửa lỗi

`dialect` đổi thành `KnownDialect | "auto"`, mặc định `"auto"`. Khi là `"auto"`,
wizard **không gửi** field `dialect`, để server tự nhận diện. Khi người dùng chọn
tay thì mới gửi.

### 4.2 Nhận diện ngay ở bước 1, trên trình duyệt

Ngay khi chọn file, đọc **64KB đầu** (`file.slice(0, 65536).text()`) để lấy dòng
tiêu đề rồi chạy `detectDialect()`. Không gọi server, không parse cả file, không
chờ.

**Vấn đề bảng mã, và vì sao cách này vẫn an toàn.** Bước 1 diễn ra *trước* khi
người dùng chọn bảng mã ở bước 3, nên đoạn 64KB này bị giải mã như UTF-8. Với file
xuất từ Excel tiếng Việt (windows-1258) thì tên cột có dấu sẽ ra ký tự lỗi.

Nhận diện vẫn đúng, vì `detectDialect()` chỉ so các tên cột **thuần ASCII** —
`handle`, `variant sku`, `sku`, `regular price`, `title`, `image1` — và những chuỗi
này giữ nguyên byte qua cả UTF-8, windows-1258 và latin1. Nghĩa là phần quyết định
định dạng không bị ảnh hưởng.

Nhưng **danh sách cột hiện trong bộ ánh xạ có thể bị lỗi ký tự**, và điều đó thì
có ảnh hưởng thật vì người dùng phải đọc nó để chọn. Xử lý: đọc lại đoạn đầu bằng
đúng bảng mã đã chọn mỗi khi người dùng đổi bảng mã ở bước 3, và ở bước 1 nói rõ
đây là danh sách cột đọc tạm. Riêng tên cột tiếng Việt có dấu (`"Giá gốc"`) thì chỉ
đúng sau khi chọn bảng mã — không được hứa hơn thế.

Bước 1 hiện một hàng lựa chọn: **Shopify / WooCommerce / Etsy / Custom**, cái
nhận ra được thì chọn sẵn kèm nhãn "nhận diện từ các cột trong file của bạn", và
đổi được ngay tại chỗ. **Custom mở bộ ánh xạ cột ngay ở bước 1** — đây là yêu
cầu chính: không phải preview lỗi rồi mới quay lại.

Khi không nhận ra được, giao diện **nói thẳng là không nhận ra** và mời chọn tay
hoặc ánh xạ cột. Không âm thầm mặc định Shopify như hiện nay.

### 4.3 Tách module — và một khẳng định sai của bản spec đầu

**Bản đầu của spec này nói sai.** Nó khẳng định rằng Client Component import
`lib/sources/csv.ts` sẽ **build lỗi** `Can't resolve 'net'`, vì file đó chạm tới
`gop-client.ts` và `gop-client` dùng `node:crypto`.

Kiểm tra lại thì không phải. Dòng import đó là:

```ts
import type { Product, ProductVariation } from "../gop-client";
```

`import type` bị **xoá hoàn toàn lúc compile**, nên không có gì của `gop-client`
đi vào bundle. Bằng chứng rõ hơn nữa: `app/(app)/import/column-mapper.tsx` là
Client Component và **đã** import `CSV_FIELDS` từ `lib/sources/csv` từ trước, và
build vẫn xanh.

Vậy đây **không** phải cái bẫy đã gặp với `lib/jobs.ts` — chỗ đó `bullmq` được
import làm **giá trị**, nên mới vỡ thật.

Việc tách vẫn nên làm, nhưng vì lý do đúng: `csv.ts` dài 451 dòng và chứa toàn bộ
parser cùng `papaparse`. Kéo tất cả vào bundle trình duyệt chỉ để gọi
`detectDialect()` trên một dòng tiêu đề là lãng phí thật (papaparse ~45KB sau khi
nén), và nó xoá nhoà ranh giới giữa "thứ trình duyệt cần" và "thứ chỉ server
cần" — điều sẽ càng đáng kể khi bước 1 bắt đầu đọc file phía client.

Nói cách khác: tách vì **dung lượng bundle và ranh giới rõ ràng**, không phải vì
build sẽ vỡ.

Tách sang `lib/sources/csv-dialect.ts`, thuần, không phụ thuộc gì:

- `CsvDialect`, `KnownDialect`
- `detectDialect(headers)`
- `CSV_FIELDS` (bảng ánh xạ cột)
- nhãn hiển thị của từng định dạng

`csv.ts` re-export lại để code phía server vẫn có một cửa vào duy nhất — giống
cách `lib/stores.ts` re-export `storeLabel` từ `lib/store-links.ts`.

### 4.4 Custom: đọc BẤT KỲ file CSV nào và tự map cột

Đây là yêu cầu riêng và nó **lớn hơn "ép dialect rồi đổi tên cột"**.

Cơ chế `columnMap` hiện tại chỉ map *tên cột thật* → *tên cột mà một dialect đã
biết mong đợi*. Nghĩa là muốn đọc một file lạ, người dùng phải chọn Shopify rồi
map cột của mình vào `Handle`, `Variant SKU`, `Option1 Name`… — tức phải hiểu
định dạng Shopify để mô tả file không phải Shopify của mình. Đó là bắt người dùng
làm việc của máy.

Thêm một dialect thật: **`custom`**, với bộ field theo đúng khái niệm sản phẩm chứ
không theo sàn nào:

| Field | Bắt buộc | Phạm vi |
|---|---|---|
| `name` | có | sản phẩm |
| `sku` | | sản phẩm |
| `description`, `short_description` | | sản phẩm |
| `price`, `regular_price`, `sale_price` | | sản phẩm |
| `categories`, `tags` | | sản phẩm |
| `images` | | sản phẩm |
| `stock`, `instock` | | sản phẩm |
| `slug`, `status`, `shipping_class` | | sản phẩm |
| `parent_sku` | | biến thể |
| `attribute_1_name` / `attribute_1_value` (và bộ 2, 3) | | biến thể |

Chỉ `name` là bắt buộc — mọi thứ khác thiếu thì bỏ qua, không phải lỗi. Một file
hai cột (tên và giá) vẫn import được, và đó là điểm chính: **file nào cũng đọc
được miễn là chỉ ra được cột nào là tên sản phẩm.**

Bộ ánh xạ ở bước 1 khi chọn Custom sẽ hiện: cột bên trái là field chuẩn ở trên,
bên phải là dropdown chọn từ **các cột thật đọc được từ file**, cộng lựa chọn
"— không có —". Đoán trước bằng so tên gần đúng (không phân biệt hoa thường, bỏ
dấu — đã có `foldVietnamese`), nên `"Tên sản phẩm"` tự khớp vào `name` và
`"Giá bán"` tự khớp vào `price`; người dùng chỉ sửa chỗ đoán sai.

Ánh xạ này vẫn được nhớ theo `columnSignature` như cơ chế hiện có, nên lần sau
xuất cùng loại file thì tự áp lại.

Biến thể trong định dạng custom nhận diện theo `parent_sku`: dòng nào có
`parent_sku` là biến thể của sản phẩm có `sku` bằng giá trị đó — cùng quy ước với
nhánh WooCommerce đang chạy, nên không phải nghĩ ra luật mới.

### 4.5 Thêm Etsy

Thêm `etsy` vào `CsvDialect`, `CSV_FIELDS`, hàm nhận diện, và một nhánh parser.
Theo định dạng "Download Listings" tiêu chuẩn của Etsy: `TITLE`, `DESCRIPTION`,
`PRICE`, `CURRENCY_CODE`, `QUANTITY`, `TAGS`, `MATERIALS`, `SKU`,
`IMAGE1`…`IMAGE10`, `VARIATION 1 TYPE` / `VARIATION 1 NAME` /
`VARIATION 1 VALUES` (và bộ 2 tương ứng).

Nhận diện: có `title` và (`image1` hoặc `variation 1 type`), và **không** có
`handle` (để không tranh với Shopify).

**Etsy sẽ được ghi rõ trong README là chưa test với file xuất thật.** Cột của
Etsy đổi theo ngôn ngữ tài khoản và theo việc listing có biến thể hay không, nên
không có file mẫu thì đây là code viết theo tài liệu chứ không phải theo thực tế.
Bộ ánh xạ cột là lối thoát cho mọi sai khác.

### 4.6 Dịch csv.ts sang tiếng Anh

Các chuỗi người dùng thấy trong `lib/sources/csv.ts` hiện là tiếng Việt
(`"Thiếu cột Handle"`), lệch với phần còn lại của app. Dịch phần **chuỗi người
dùng thấy** và nhãn cột sang tiếng Anh. Nằm trong phạm vi phần A vì lỗi định dạng
chính là thứ tính năng này làm hiện ra.

### 4.7 Kiểm chứng phần A

Trong `tests/isolation.sh` (có server thật), đẩy file mẫu qua
`POST /api/import/preview` bằng multipart:

1. file Shopify → nhận ra `shopify`;
2. file WooCommerce → nhận ra `woocommerce` **(đây là ca mà code hiện tại sai)**;
3. file Etsy → nhận ra `etsy`;
4. file cột lạ → trả về "không nhận ra" **kèm danh sách cột thật**, không đoán;
5. file WooCommerce nhưng ép `dialect=shopify` → vẫn theo lệnh người dùng, chứng
   minh chọn tay thắng nhận diện tự động;
6. **file cột hoàn toàn lạ + `dialect=custom` + `columnMap`** → đọc ra đúng sản
   phẩm. Đây là ca chứng minh yêu cầu "file nào cũng map vào được";
7. file custom chỉ có **hai cột** (tên và giá) → vẫn ra sản phẩm, không báo lỗi
   thiếu cột.

Ca số 2 phải **fail trước khi sửa** và pass sau khi sửa.

---

## 5. Phần B — Logs khi import (lớn nhất, làm sau cùng)

### 5.1 Lưu ở đâu

Bảng mới, xoá theo run:

```
job_log
  id          bigserial primary key
  job_id      text not null references job(id) on delete cascade
  at          timestamptz not null default now()
  level       text not null          -- debug | info | warn | error
  stage       text not null          -- run | limits | s3 | images | batch | plugin | cancel | transients | finish
  batch_index integer                -- null khi không thuộc batch nào
  message     text not null
  detail      jsonb                  -- số liệu có cấu trúc, không bắt buộc
index (job_id, id)
```

`id` là `bigserial` để phân trang theo con trỏ (`after=<id>`) có thứ tự ổn định.
Dùng `at` làm con trỏ thì hai dòng cùng millisecond sẽ nhập nhằng.

Lưu ở **Postgres**, không phải Redis và không phải file, cùng lý do với mọi thứ
khác trong hệ này: log mà mất khi deploy lại thì không giải thích được lượt chạy
đêm qua.

Nó cascade theo run, nên **ba chỗ phải cập nhật cùng lúc**, không được quên chỗ
nào:

1. `JobFootprint` thêm trường `logs`, và `total` cộng thêm số dòng đó;
2. câu xác nhận khi xoá (cả trên trang chi tiết và trong dialog xoá nhiều) hiện
   đang liệt kê "result rows, batch records và staged payload" — phải thêm log
   vào, nếu không con số tổng sẽ lớn hơn phần được kể tên và người đọc sẽ thắc
   mắc phần chênh ở đâu;
3. test xoá trong `tests/cancel.sh` đang kiểm `job_result` / `job_batch` /
   `job_item` biến mất — thêm `job_log`.

Con số "sẽ xoá bao nhiêu dòng" đã là một lời hứa hiện trên màn hình, nên để nó sai
còn tệ hơn là không có.

### 5.2 Ghi thế nào

`lib/job-log.ts` với hàm `logJob(jobId, entries[])`.

**Ghi ngay tại thời điểm sự kiện xảy ra, không gom.**

Bản đầu của spec này chọn gom log theo ranh giới batch để tiết kiệm round trip.
**Quyết định đó bị bỏ**, vì nó xung đột trực tiếp với yêu cầu log realtime: với
một site chậm, một batch mất tới hai phút, nên gom theo ranh giới nghĩa là màn
hình trống suốt hai phút rồi mới hiện một loạt dòng cùng lúc. Đó đúng là thứ cần
tránh — người dùng mở log lên chính là để biết **lúc này** đang làm gì.

Lý do ban đầu để gom cũng không đứng được khi xem lại: vòng lặp batch **không
phải vòng nóng**. Mỗi batch là một lời gọi HTTP tính bằng giây đến hàng phút, nên
5–10 lệnh INSERT nhỏ rải trong khoảng đó là không đáng kể — nó không nằm cùng
thang thời gian với thứ nó chạy song song.

Nên: mỗi sự kiện là một `logJob()` ngay tại chỗ. Kèm theo đó, mốc **"bắt đầu gửi
batch N"** được ghi *trước* khi gọi HTTP, không phải sau — nếu chỉ ghi sau khi có
kết quả thì một batch treo hai phút sẽ không có dòng nào giải thích, mà đó lại
chính là lúc người dùng cần lời giải thích nhất.

Trường hợp cần chú ý: khi Stop **huỷ giữa đường**, lane thoát ra bằng `return`
ngay trong nhánh bắt `GopAbortError`. Dòng log "batch bị bỏ dở" phải nằm **trong
nhánh đó**, không ở sau — nếu không thì đúng cái sự kiện quan trọng nhất lại là
cái duy nhất bị mất.

### 5.3 Ghi những gì

Mức "mốc chính + mọi lỗi". Ước lượng 5–10 dòng mỗi batch, nên run 100 batch cho
ra khoảng 1.000 dòng — đọc được và lưu được.

| Stage | Nội dung |
|---|---|
| `run` | worker nhận việc; tóm tắt tuỳ chọn; site đích; số lane; cỡ batch; tổng số; chạy ngay hay hẹn giờ |
| `limits` | kết quả kiểm tra lại quyền khi run nổ (ca run hẹn giờ bị thu hồi quyền) |
| `s3` | bucket lấy được — **chỉ tên bucket** — hoặc lý do từ chối |
| `images` | mỗi batch: chuẩn bị được bao nhiêu, lỗi bao nhiêu, URL nào lỗi (cắt bớt) |
| `batch` | thứ tự, cỡ, offset, lúc gửi, trả lời sau bao nhiêu ms (thời gian plugin và thời gian thực tách riêng), thành công/lỗi/đã có |
| `plugin` | mọi dòng lỗi kèm mã và thông báo |
| `batch` | `request_timeout` kèm số giây, khi hết thời gian chờ |
| `cancel` | ai yêu cầu, kiểu `cancel` hay `stop`, mỗi lane dừng ở batch nào, batch nào bị bỏ dở mà không ghi kết quả |
| `transients` | đã xoá cache WooCommerce hay lỗi |
| `finish` | trạng thái cuối, tổng số, thời gian thực |

### 5.4 Điều tuyệt đối không ghi

Không ghi payload, không ghi header, không ghi API key, không ghi secret S3,
không ghi chữ ký HMAC. Header mang API key của site và payload là toàn bộ danh
mục của khách.

Việc này được **test bảo đảm**: `tests/e2e.sh` và `tests/isolation.sh` đã grep
output tìm secret; mở rộng sang **nội dung bảng `job_log`** để nếu ai đó vô tình
log một secret thì test đỏ, chứ không phụ thuộc vào sự cẩn thận khi review.

### 5.5 Đọc và hiển thị

Hai route, cả hai qua `apiRequireOwned("job", id)` — tài khoản khác trả 404, không
bao giờ 403, đúng như mọi route `[id]` khác:

- `GET /api/jobs/[id]/logs?after=<id>&limit=500` — đọc theo trang. Dùng cho lần
  tải đầu và cho run đã kết thúc.
- `GET /api/jobs/[id]/logs/stream` — **SSE, realtime.** Dùng khi run đang chạy.

### Realtime hoạt động thế nào

Đúng mô hình đã dùng cho Stop ở task trước, và vì đúng lý do:

1. Worker ghi dòng log vào Postgres — **Postgres là nguồn sự thật duy nhất**.
2. Ngay sau đó worker `PUBLISH` id của run lên một channel Redis
   (`gop:job:log`). Đây chỉ là **tiếng gõ cửa**, không mang nội dung.
3. Route SSE `subscribe` channel đó. Khi nghe thấy id mình đang theo, nó đọc
   Postgres từ con trỏ `after` và đẩy các dòng mới xuống client.

Vì sao không đẩy thẳng nội dung log qua pub/sub: mất một message là mất một dòng
log vĩnh viễn, và không có cách nào biết là đã mất. Ở mô hình này, mất message chỉ
làm **chậm** — con trỏ vẫn ở đó, và nhịp đập dự phòng (2 giây) sẽ lấy nốt. Mất
tốc độ chứ không mất dữ liệu, giống hệt lý do đã chọn cho Stop.

Nhịp đập dự phòng cũng là thứ đảm bảo log hiện đúng khi Redis chết hẳn: chậm hơn,
nhưng vẫn chạy.

### Giao diện

**Khung log ở dưới cùng trang chi tiết run** (`/process/[id]`):

- chữ monospace, dòng mới ở dưới, mỗi mức một màu theo token của design system;
- **tự cuộn khi đang chạy, và tự tắt chế độ đó ngay khi người dùng cuộn lên** —
  nếu không thì không ai đọc được dòng cũ; có nút "về cuối" để bật lại;
- lọc theo mức (tất cả / cảnh báo trở lên / chỉ lỗi);
- copy toàn bộ, tải về `.txt`;
- một chỉ báo cho biết đang nối realtime hay đã rơi về nhịp đập, giống
  `ConnectionIndicator` của status bar — người đọc phải biết cái mình đang xem có
  còn sống hay không.

Thời gian mỗi dòng render bằng component trong `client-time.tsx` — cùng lý do
hydration như trên.

### 5.6 Kiểm chứng phần B

`tests/cancel.sh` là nơi tốt nhất, vì nó đã chạy worker với site không bao giờ
trả lời, tức sinh ra đúng những dòng log đáng quan tâm nhất:

1. run hiện dòng `run` mở đầu với tuỳ chọn và site;
2. mỗi batch bị hết thời gian chờ hiện dòng `request_timeout` kèm số giây;
3. khi Cancel: có dòng ghi ai yêu cầu, kiểu gì, và lane dừng ở đâu;
4. khi Stop: có dòng ghi batch bị **bỏ dở**, và số dòng log về batch đó khớp với
   việc results **không** có dòng nào cho batch đó;
5. dòng log đúng thứ tự theo `id`;
6. **không secret nào** trong toàn bộ bảng `job_log`;
7. xoá run thì log xoá theo, và `jobFootprint()` đã đếm số dòng log đó trước khi
   hỏi xác nhận.

`tests/e2e.sh` thêm ca luồng thuận: batch gửi và được trả lời có đủ dòng với
`elapsed_ms` của plugin.

---

## 6. Thứ tự làm và lý do

1. **C — bản quyền.** Nhỏ nhất, phần lớn đã có, một cột mới. Làm trước để nếu anh
   cần bán key thì có ngay.
2. **A — nhận diện định dạng.** Là sửa lỗi, đang ảnh hưởng người dùng thật ngay
   lúc này (file Woo hợp lệ báo lỗi vô nghĩa).
3. **B — logs.** Lớn nhất, một bảng mới, một route mới, một khung UI mới. Làm sau
   cùng, và nó dùng lại chính hạ tầng test mà A và C đã mở rộng.

Mỗi phần chạy hết `pnpm typecheck && pnpm lint && pnpm build` cộng cả ba bộ test
trước khi sang phần sau, và báo cáo lại giữa các phần.

## 7. Những gì spec này KHÔNG làm

- Không chuyển giao diện sang tiếng Việt (đã chốt: giữ tiếng Anh).
- Không chống spam đăng ký (xác minh email, giới hạn IP) — hệ quả của mục 3.1 đã
  ghi rõ, nhưng để thành task riêng.
- Không log payload hay header ở bất kỳ mức nào.
- Không tự động gia hạn hay thanh toán. Admin tạo key, người dùng nhập key.
- Không sửa `MAX_BATCH_SIZE` hay giao thức với plugin.
