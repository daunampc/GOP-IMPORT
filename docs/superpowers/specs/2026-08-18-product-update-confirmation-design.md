# Cập nhật sản phẩm: ngữ nghĩa ghi, và câu xác nhận trước khi ghi

Ngày: 2026-08-18

Tài liệu này viết bằng tiếng Việt vì người duyệt nó là chủ sản phẩm. **Code,
comment trong code và toàn bộ giao diện vẫn là tiếng Anh** theo đúng quy ước hiện
tại của repo.

Đây là **checkpoint của §7**: §2.1 và §2.5 ghi đè lên sản phẩm đang bán, nên câu
xác nhận phải được chốt *trước* khi viết code. Tài liệu chỉ bàn hai thứ đó cộng
những quyết định không thể trì hoãn. Chưa viết dòng code nào.

---

## 0. Một lỗi tìm được khi đọc, cần quyết định ngay

`index.php:337` và `admin/Actions.php:256` đều gọi:

```php
CALL `tsd_clear_woocommeerce_transients`(0)
```

`sql/14_clear_transients.sql` bắt đầu bằng:

```sql
CREATE PROCEDURE `clear_woocommeerce_transients`(_idParent INT)
BEGIN
	IF(_idParent IS NOT null)
    THEN
		DELETE FROM `wp_options` WHERE `option_name` like CONCAT('%_', _idParent);
```

`0` **không phải** `NULL`. Nên nhánh chạy là nhánh đầu, và câu lệnh thật sự chạy là:

```sql
DELETE FROM wp_options WHERE option_name LIKE '%_0'
```

Nghĩa là:

1. **Nó chưa bao giờ xoá transient của WooCommerce.** Mười câu `DELETE` đúng nằm
   ở nhánh `ELSE`, chỉ chạy khi tham số là `NULL`.
2. **Nó xoá thứ khác.** Bất kỳ hàng `wp_options` nào có `option_name` kết thúc
   bằng `_0` đều bị xoá — không giới hạn ở transient, không giới hạn ở WooCommerce.
3. Dòng log `"Cleared WooCommerce's transients, so category pages show the new
   prices."` (`worker/index.ts:857`) vì thế là một lời hứa không đúng, và nút
   Maintenance trong wp-admin cũng vậy.

Điều này liên quan trực tiếp tới §2.1: yêu cầu "cập nhật xong phải xoá transient,
nếu không giá cũ vẫn hiện ở trang danh mục" *chính là* bug mà người dùng nghĩ là
"công cụ không làm gì cả". Nếu đường ghi mới cũng dùng lại procedure này thì nó
thừa hưởng nguyên lỗi.

**Đề xuất:** không sửa chữ ký procedure (nhiều site đã cài), mà:

- Đường cập nhật mới **không dùng** procedure cho phần transient. `ProductUpdater`
  tự viết `DELETE` chính xác theo id sản phẩm, cùng kỷ luật mà `ProductDeleter`
  đã chọn khi từ chối `delete_product_by_id`.
- Sửa hai chỗ gọi từ `(0)` thành `(NULL)`. Đây là sửa một ký tự và làm cho câu
  log hiện có trở thành đúng.

Việc 2 nằm ngoài phạm vi bốn việc đã nêu. **Cần chủ sản phẩm quyết**: gộp vào đợt
này, hay tách ra một việc riêng. Tôi khuyên gộp — nó cùng file, cùng lần build
plugin, và để nguyên thì §2.1 vẫn báo "đã xoá cache" trong khi không xoá.

---

## 1. §2.1 — ngữ nghĩa ghi. Tính chất mà cả tính năng dựa vào

### 1.1 Ba trạng thái của một trường, và không có trạng thái thứ tư

Giao thức đọc theo **sự có mặt của khoá**, không theo giá trị:

| Trên dây | Nghĩa |
|---|---|
| khoá không xuất hiện | **không chạm tới**. Giá trị cũ ở lại y nguyên |
| `"description": ""` | **xoá trắng có chủ ý** |
| `"description": null` | **từ chối** dòng đó, mã lỗi `null_field`, không đoán |

PHP phân biệt được ba trạng thái này: `json_decode($body, true)` cho ra array mà
khoá vắng thì không tồn tại, và `array_key_exists()` tách "vắng" khỏi "null". Nên
giao thức này hiện thực được đúng như mô tả, không phải xấp xỉ.

`null` bị từ chối chứ không coi như `""`, vì hai thư viện client khác nhau sẽ
serialize một field rỗng theo hai cách khác nhau, và đoán sai ở đây nghĩa là xoá
trắng mô tả sản phẩm.

### 1.2 Trường nào ghi được, trường nào không — và vì sao

**Sản phẩm** (`post_type = 'product'`):

`name`, `description`, `short_description`, `status`, `price`, `regular_price`,
`sale_price`, `stock`, `instock`, `categories`, `tags`, `shipping_class`,
`custom_meta`.

**Biến thể** (`post_type = 'product_variation'`, khớp bằng SKU của chính nó):

`price`, `regular_price`, `sale_price`, `stock`, `instock`, `status`,
`description`.

**Cố tình KHÔNG cho ghi**, mỗi cái vì một lý do cụ thể:

| Trường | Vì sao không |
|---|---|
| `images` | Sửa gallery nghĩa là tạo/xoá attachment. Đó đúng là kiểu "phá rồi dựng lại" mà §2.1 cấm với biến thể, và nó đổi id ảnh. Cần thì làm ở đợt riêng, có thiết kế riêng |
| `slug` | Plugin ghi thẳng DB nên không chạy `wp_unique_post_slug()`. Đổi slug thành trùng là tạo ra một sản phẩm không mở được — README đã ghi cái bẫy này |
| `type` | Đổi simple ↔ variable là dựng lại cả bộ biến thể |
| `attributes`, `variations` (cả bộ) | §2.1 cấm thẳng: xoá rồi tạo lại biến thể là đổi id |
| `sku` | Nó *là* khoá khớp. Đổi thứ mình vừa dùng để tìm, trong cùng một lời gọi, là bẫy — và với dòng không có `idempotency_key` thì không còn định danh nào khác |

Payload chứa khoá không nằm trong danh sách cho phép thì **dòng đó bị từ chối**
với mã `unsupported_field` kèm tên trường, chứ không âm thầm bỏ qua. Bỏ qua im
lặng nghĩa là người gọi tin rằng ảnh đã đổi.

### 1.3 Khớp sản phẩm: chính xác, hoặc là lỗi

Thứ tự:

1. Có `idempotency_key` → tra `tsd_import_log`. Đúng một hàng, hoặc không có.
   Không có → lỗi `not_found` cho dòng đó.
2. Không có → khớp `sku` trong `postmeta._sku`, với `post_type IN ('product',
   'product_variation')`.
   - 0 kết quả → `not_found`
   - **2 kết quả trở lên → `ambiguous_sku`**, thông báo liệt kê các `product_id`
     tìm được, và **không chạm vào bất kỳ cái nào**
3. Không có cả hai → `missing_match_key`

Không bao giờ "lấy cái đầu tiên". Hai sản phẩm cùng SKU là dữ liệu sai của site,
và đoán một trong hai là cách sửa giá sai sản phẩm mà không ai biết.

### 1.4 Giá: `_price` là trường dẫn xuất, không phải trường độc lập

WooCommerce đọc `_price` để hiển thị, và `_price` **bằng** `_sale_price` khi đang
giảm giá, ngược lại bằng `_regular_price`. `Normalizer::prices()` đã làm đúng
điều đó ở đường import.

Stored function cũ `tsd_update_product` làm **sai** chỗ này — nó ghi cùng một giá
trị vào cả `_regular_price` và `_price`, nên đặt giá gốc là mất giá sale. Cộng
với việc nó không chạm `wc_product_meta_lookup`, không giảm `count` của category
cũ khi thay category, và không xử lý biến thể. **Không dùng nó.** Viết mới bằng
PHP, đúng như `ProductDeleter` đã từ chối `delete_product_by_id`.

Luật:

- `regular_price` và `sale_price` là đầu vào. `price` là **bí danh** của
  `regular_price` khi `regular_price` vắng mặt — giống `Normalizer`.
- `_price` được **tính lại** mỗi khi một trong hai đầu vào thay đổi:
  `_price = sale_price !== '' ? sale_price : regular_price`
- Tính lại cần giá trị **hiện tại** của trường không nằm trong payload, nên phải
  đọc nó ra. Đây là yêu cầu thật, không phải tối ưu: `{sku, sale_price: ""}`
  (kết thúc giảm giá) phải đưa `_price` về đúng `_regular_price` đang có.

### 1.5 Bảng lookup và cache — phần quyết định "giá có hiện hay không"

Ghi `postmeta` xong là chưa xong. Với mỗi sản phẩm được sửa:

1. **`wc_product_meta_lookup`**: cập nhật `sku`, `min_price`, `max_price`,
   `onsale`, `stock_quantity`, `stock_status`.
2. **Sửa biến thể thì tính lại min/max của sản phẩm cha** bằng `MIN`/`MAX` trên
   toàn bộ biến thể của nó — không dùng phép `IF` tăng dần của `create_product`,
   vì phép đó chỉ đúng khi đang *thêm* biến thể, và sai khi *hạ* giá một biến thể
   đang là min.
3. **Transient**: xoá theo id sản phẩm bằng `DELETE` chính xác (xem §0), không
   dùng procedure.

Điểm 1 và 2 là khác biệt giữa "giá đã đổi" và "trang danh mục hiện giá mới".

### 1.6 Giao dịch, và mỗi dòng độc lập

Giữ nguyên hình dạng của `importOne()`: mỗi dòng một transaction — `begin`, ghi,
`commit`, và `rollback` **toàn bộ dòng** nếu bất kỳ bước nào lỗi. Một sản phẩm
sửa nửa vời tệ hơn một sản phẩm không đổi gì. Một dòng lỗi không kéo cả batch.

### 1.7 Trả về: những gì **thật sự** đổi

Mỗi dòng:

```json
{
  "index": 0,
  "ok": true,
  "product_id": 8412,
  "sku": "AO-001",
  "is_variation": false,
  "parent_id": null,
  "changed": {
    "regular_price": { "from": "199000", "to": "219000" },
    "price":         { "from": "199000", "to": "219000" }
  }
}
```

Hai quyết định trong hình dạng này:

- **`from` và `to`, không chỉ tên trường.** §2.1 chỉ yêu cầu "trường nào đã đổi",
  nhưng có giá trị cũ mới làm được §2.5: bảng kết quả của run hiện được
  "199,000 → 219,000" từng dòng, và **run trở thành bản ghi duy nhất của giá cũ**.
  Đây là thứ khiến một lần sửa hàng loạt còn có đường lần lại.
- **Chỉ báo khi giá trị lưu **thật sự** khác.** Gửi `{sku, price: 199000}` cho
  sản phẩm đang là `199000` trả về `changed: {}` và `ok: true`. Đó là cách đếm ra
  câu "340 sản phẩm, 340 giá đổi, 0 mô tả bị chạm".

`MAX_UPDATE_BATCH = 50`, đúng bằng `MAX_BATCH_SIZE` và `MAX_DELETE_BATCH`.

---

## 2. §2.5 — ba mức xác nhận, cho ba mức nguy hiểm

Nguyên tắc: **câu xác nhận phải hiện con số thật, không phải số lượng.** "Sửa
340 sản phẩm" không bắt được một phần trăm đặt sai; "199,000 → 219,000" thì bắt
được.

### Mức 1 — sửa một sản phẩm

Drawer, giá trị cũ đặt cạnh giá trị mới, từng trường. Không phải gõ gì.

Một sản phẩm, và toàn bộ khác biệt nhìn thấy hết trên màn hình. Lưu là gọi
`/products/update` một dòng, đồng bộ, không qua queue — dựng một run cho một sản
phẩm là nghi thức chứ không phải an toàn.

### Mức 2 — sửa hàng loạt, ≤ 20 sản phẩm, giá trị tuyệt đối

Bảng preview hiện **mọi dòng** sẽ đổi, kèm số thật. Nút xác nhận ghi con số.
Không phải gõ gì — vì mọi dòng đều đọc được.

### Mức 3 — phải gõ `UPDATE`

Bắt buộc gõ khi **một trong hai** điều sau đúng:

1. **Run bao trên 20 sản phẩm** — tức preview không thể hiện hết từng dòng nó
   sắp sửa.
2. **Thay đổi là tương đối** (theo phần trăm, hoặc cộng/trừ một số tiền), bất kể
   lớn nhỏ. Một phần trăm áp lên filter sai là kiểu lỗi mà §7 gọi tên, và 12 sản
   phẩm bị −90% vẫn là một danh mục sai giá, chỉ nhỏ hơn.

Hai điều kiện, nói được thành hai câu trên màn hình. Chữ phải gõ là `UPDATE`,
song song với `DELETE` của màn hình xoá, và **kiểm lại ở route handler** đúng như
`CONFIRM_PHRASE` hiện nay — chữ xác nhận chỉ tồn tại trong trình duyệt thì chống
được cái nhấp chuột lỡ và không chống được gì khác.

### 2.1 Preview hiện những gì

**Hai mươi dòng đầu, đầy đủ.** Mỗi dòng: tên sản phẩm, SKU, `giá hiện tại → giá
mới`, và `giá sale hiện tại → giá sale mới` khi thay đổi chạm tới nó. Sau đó một
dòng: "… và 3.320 dòng nữa đổi theo cùng cách".

Vì sao 20 chứ không phải 500 như màn hình xoá: đọc 500 cái tên là một việc kiểm
tra có thật, đọc 500 kết quả phép tính thì không. Hai mươi dòng đủ bắt hai lỗi
hay xảy ra nhất — filter sai (tên sản phẩm lạ hiện ra ngay mấy dòng đầu) và phép
tính sai (hiện ra ngay dòng đầu).

**Ba con số tính trên TOÀN BỘ selection, không phải trên 20 dòng hiện ra** — chỗ
này quan trọng, vì một con số tính trên phần hiện ra là con số nói dối:

| Con số | Bắt được gì |
|---|---|
| giá mới thấp nhất và cao nhất trong cả selection | gõ sai phần trăm (`-90` thay vì `-9`) |
| số dòng sẽ về **≤ 0** | **từ chối cả run**, không kẹp về 0 |
| số dòng sẽ có `sale_price ≥ regular_price` | **cảnh báo**, không từ chối |

Dòng về ≤ 0 thì **từ chối, không cắt gọt** — đúng §4.4. Thông báo nêu số dòng và
vài SKU đầu; người dùng sửa filter hoặc sửa con số. Kẹp về 0 rồi báo thành công
là biến một lỗi thành một danh mục bán giá 0.

`sale_price ≥ regular_price` thì chỉ cảnh báo, vì WooCommerce cho phép — nó vô
nghĩa chứ không sai.

### 2.2 Câu xác nhận nói đúng những gì

Theo kỷ luật của `STOP_WARNING`: **nói cả điều không bảo đảm được.**

> Updating **3,340** products on **shop.example.com**.
>
> This changes the **price** of every one of them and touches nothing else — no
> description, no image, no stock, no category.
>
> There is no undo. The previous price of every row is recorded in this run's
> results, so **this run's own page is the only record of what the prices were**.
>
> If this run is cancelled halfway, the products already updated **stay
> updated**. Cancel stops the run; it does not put prices back.

Câu cuối là §4.4 điều bốn, áp dụng thật thà. Cancel một run xoá thì phần chưa
xoá còn nguyên; cancel một run sửa giá thì phần đã sửa **đã sửa rồi** — đó là
lời hứa khác, và phải nói ra.

Câu "touches nothing else" chỉ được viết ra vì §1.1 và §1.2 làm cho nó đúng. Nếu
partial update không đúng, câu này là lời nói dối tệ nhất trên màn hình.

### 2.3 Bản ghi giá cũ — và hệ quả

Mỗi dòng kết quả của run sửa hàng loạt lưu `changed` (§1.7) vào `job_result`.
Nghĩa là:

- Bảng kết quả của run hiện `199,000 → 219,000` từng dòng.
- Xuất CSV đã có sẵn, nên giá cũ xuất được ra file.
- Về nguyên tắc, run đó **đủ dữ liệu để dựng một run đảo ngược**.

Việc dựng nút "đảo ngược run này" **không** nằm trong phạm vi đợt này. Tôi ghi lại
đây vì nó là hệ quả trực tiếp của việc lưu `from`, và nếu chủ sản phẩm muốn thì
nói ngay bây giờ sẽ rẻ hơn nhiều so với nói sau — cột dữ liệu đã có sẵn hình dạng
đúng.

---

## 3. Những quyết định thường, tôi tự chọn và nói ra

| Chỗ | Chọn | Vì sao |
|---|---|---|
| `job.kind` | thêm thành viên thứ ba: `"update"` | `job.kind` là enum ở tầng TypeScript, không phải PG enum, nên không cần migration cho DB. Khác với `JobStatus`: `isImportRun`/`isPurgeRun` đã có nên thành viên mới hiện ra thành lỗi biên dịch ở từng chỗ `switch` — đúng thứ mình muốn — và không có cột nào suy ra được "đây là run sửa" |
| Cột mới | `job_result.changed jsonb` | Song song với `removed` đang có. Migration riêng, chỉ `ADD COLUMN`, không kèm `DROP` nào (§4.3) |
| Switch theo account | thêm `productEditEnabled` vào `account_limit` | Nó sửa được giá cả danh mục, nên xứng đáng có switch riêng. **Vắng nghĩa là được phép**, đúng luật hiện hành |
| Switch đó tắt thì | màn hình `/products` thành **chỉ đọc**, không biến mất | Xem danh mục của chính mình không nguy hiểm, và còn tìm được sản phẩm để mở trong wp-admin. Route ghi trả 403 |
| Sửa một sản phẩm | đồng bộ, không qua queue | Một sản phẩm không cần progress, log, Cancel |
| Sửa hàng loạt | **là một run**, qua queue/worker/log/cancel | §3 chốt rồi |
| Xoá transient | một lần cuối run (hàng loạt), theo từng id (một sản phẩm) | Giống import: 3.000 lời gọi riêng chậm hơn và không đúng hơn |
| `/products/exists` | cap 1.000 SKU/request | §2.2 đề xuất, và nó vừa với một câu `IN (...)` |
| `/products/exists` trả | `product_id`, `name`, `sku`, `price`, `status`, `type` | `status` và `type` thêm vào so với §2.2: preview cần nói được "1.198 dòng đã có, trong đó 12 đang là draft" |

---

## 4. Thứ tự làm, và chỗ dừng báo cáo

1. **Plugin** — `/products/update` (§2.1), `/products/exists` (§2.2),
   `/maintenance/recalculate-prices` (§2.3), + sửa `(0)` → `(NULL)` nếu được
   đồng ý. Test plugin xanh, kể cả test partial update phải **đỏ trước khi** có
   `ProductUpdater`. → *dừng, báo cáo*
2. **Client + import modes** (§2.4) — `updateProducts`, `productsExist`,
   `MAX_UPDATE_BATCH`, ba chế độ import, preview dùng `/products/exists`.
   → *dừng, báo cáo*
3. **Màn hình `/products`** (§2.5) — theo đúng thiết kế xác nhận ở §2 trên.
   → *dừng, báo cáo*
4. **Retry theo batch** (§2.6) + bốn việc nhỏ §6 nếu còn thời gian.

---

## 5. Cần chủ sản phẩm trả lời

1. **§0** — gộp việc sửa `clear_woocommeerce_transients(0)` → `(NULL)` vào đợt
   này, hay tách riêng? (Tôi khuyên gộp.)
2. **§2 mức 3** — ngưỡng 20 sản phẩm và "mọi thay đổi tương đối" có đúng ý không?
   Chặt hơn thì hạ ngưỡng; lỏng hơn thì bỏ điều kiện 2.
3. **§2.3** — có muốn nút "đảo ngược run này" không? Trả lời bây giờ rẻ hơn trả
   lời sau.
4. **§1.2** — danh sách trường không cho ghi (`images`, `slug`, `type`,
   `attributes`, `sku`) có thiếu cái nào cần ghi thật không?
