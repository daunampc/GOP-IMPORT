# Chuyển việc tải ảnh từ PHP sang web

Ngày: 2026-08-19

Tài liệu này viết bằng tiếng Việt vì người duyệt nó là chủ sản phẩm. **Code,
comment trong code và toàn bộ giao diện vẫn là tiếng Anh** theo đúng quy ước hiện
tại của repo.

Phạm vi: hai repo.

- Web: `/Volumes/Personal/Company/toshstack.dev/clients/manager-push-product-wordpress`
- Plugin: `/Volumes/Personal/Company/GPM_toshstack` (3.8.0 → **3.9.0**)

**Trạng thái: đã cài đặt xong.** Tài liệu này được **cập nhật lại sau khi code
chạy**, không để nguyên bản thiết kế ban đầu — vì bốn chỗ trong bản đầu là **sai**,
và một tài liệu sai còn tệ hơn không có tài liệu. Mỗi chỗ đó được đánh dấu bằng một
khối `> **Sửa so với bản đầu**` ngay tại mục của nó, kèm lý do, chứ không lặng lẽ
viết lại — cái *đã nghĩ sai* là phần có giá trị nhất để đọc lại lần sau:

| § | Bản đầu | Thực tế |
|---|---|---|
| §3.3 | trần một ảnh 32 MB | **22 MB** — base64 trong body 32 MB không chở nổi hơn |
| §4.1 | viết SSRF guard mới trong `image-download.ts` | nâng cấp `outbound-url.ts` đang có — guard mới là **chỗ thứ ba** của cùng một luật |
| §4.1.2 | `GOP_ALLOW_PRIVATE_IMAGE_HOSTS` bật/tắt toàn bộ | **allowlist theo host** — bật/tắt toàn bộ làm test vô nghĩa |
| §4.4 | gate đặt trong `plugin-support.ts` | **`plugin-version.ts`** — `plugin-support.ts` là `server-only`, worker crash |

Kết quả kiểm chứng ở §10.

---

## 1. Vấn đề

Chế độ ảnh `upload_site` ("Copy into the site's media library") hôm nay hoạt động
như sau:

1. Worker gom URL ảnh của từng batch sản phẩm (`worker/index.ts:467`, và `:682`
   cho luồng update).
2. Web **chỉ gửi danh sách URL** xuống plugin, chia lô 40 URL mỗi request
   (`lib/images.ts:66-91`) qua `POST /images/fetch` (`lib/gop-client.ts:509`).
3. **PHP tự đi tải ảnh**: `src/Media/ImageFetcher.php` dùng `curl_multi`, 8 lane
   song song, timeout 20s mỗi ảnh, trần 32 MB mỗi ảnh, ghi file bằng
   `file_put_contents`.

Đọc từ chính source, đây là những con số làm PHP mất ổn định:

- Mỗi request `/images/fetch` **giữ một process PHP-FPM** suốt thời gian tải.
  40 ảnh / 8 lane = 5 đợt, mỗi đợt có thể chạm timeout 20s ⇒ **tới ~100s cho một
  request**, trong khi client bỏ cuộc ở 120s (`DEFAULT_REQUEST_TIMEOUT_MS`,
  `lib/gop-client.ts:377`).
- `threads` cho phép tới 32 lane song song ⇒ tới **32 process PHP bị chiếm**, mỗi
  process mở 8 kết nối ra ngoài ⇒ ~256 outbound connection phát ra từ chính con
  web của khách. Pool PHP-FPM cạn thì khách thật ăn 502/504.
- `CURLOPT_RETURNTRANSFER` giữ **toàn bộ body trong RAM** (tối đa 32 MB × 8 lane)
  rồi mới ghi file ⇒ dễ đụng `memory_limit`.
- Mỗi URL còn một lần `gethostbyname()` **blocking** trước khi tải, để chặn SSRF.
- `ImageFetcher::store()` **không dedupe**: file trùng tên thì thêm `-1`, `-2`.
  Một batch bị retry để lại bản sao ảnh trong `uploads` (README `:625` đã ghi
  nhận điều này).

Code trong repo đã tự cảnh báo đúng vấn đề này: `upload_site` cộng `threads > 16`
sinh warning *"tends to choke the target site itself"*
(`lib/import-options.ts:211`).

**Mục tiêu:** web tải bytes, plugin chỉ ghi file. PHP không còn gọi mạng ra ngoài.

## 2. Ba quyết định đã chốt

| Quyết định | Chọn | Lý do |
|---|---|---|
| Ảnh nằm ở đâu | Vẫn trong Media Library của site | Giữ `_wp_attachment_metadata` thật; S3 và FIFU đều để ảnh ngoài site |
| Site còn plugin cũ | **Chặn run**, bắt update | Một đường code duy nhất, không mang hai đường song song |
| `/images/fetch` | **Xóa hẳn** | PHP không bao giờ còn gọi mạng ⇒ triệt tiêu cả SSRF surface phía site |
| Tên file | `slug` + hash ngắn | Vừa đọc được cho SEO, vừa idempotent |
| SSRF guard phía web | Đầy đủ | Bù đúng phần bảo mật mất đi khi bỏ `ImageFetcher::reject()` |
| Cache theo run | Có | Catalogue POD dùng lại ảnh rất nhiều |
| Ngân sách bytes / request | **16 MB raw** | Ngân sách gói request phía web. Trần cứng của plugin là **22 MB** — hai con số khác vai, xem §3.3 |
| Escape hatch cho SSRF guard | **allowlist theo host** | Bật/tắt toàn bộ vừa sai cho khách vừa làm test vô nghĩa — xem §4.1.2 |

## 3. Phía plugin — 3.9.0

### 3.1 Định dạng truyền: JSON + base64

```
POST /images/upload
{
  "images": [
    { "source_url": "https://cdn.example.com/a.jpg",
      "content_type": "image/jpeg",
      "bytes": "<base64>",
      "file_name": "ao-khoac-nam.jpg",
      "id_multisite": "3" }
  ]
}
```

Trả về, **cùng thứ tự với input** (giữ đúng hợp đồng của `/images/fetch` cũ):

```json
{ "ok": true,
  "images": [
    { "ok": true,
      "source_url": "https://cdn.example.com/a.jpg",
      "url": "https://shop.com/wp-content/uploads/2026/08/ao-khoac-nam-3f9a2c7b.jpg",
      "bytes": 184320,
      "skipped": false }
  ] }
```

Entry lỗi: `{ "ok": false, "source_url": "…", "error": "…" }`.

**Tại sao base64 mà không phải multipart hay binary thô** — đây là ràng buộc, không
phải sở thích:

`Auth::verify()` ký **toàn bộ body**:
`hash_hmac('sha256', "$method\n$path\n$timestamp\n$body", $secret)`, và body đọc
bằng `file_get_contents('php://input')` (`index.php:118`).

- **multipart/form-data:** PHP tự parse body vào `$_FILES` và làm `php://input`
  **rỗng** ⇒ chữ ký vỡ trên mọi request. Loại ngay.
- **binary thô, 1 ảnh/request:** metadata phải nhét vào header, mà `Auth` chỉ ký
  body ⇒ tên file thành unsigned, sửa được trong lúc truyền. Muốn ký header thì
  phải đổi `Auth::verify` — tức phá contract của **mọi build đã cài trên site
  khách**. Thêm nữa 5.000 sản phẩm × 5 ảnh = 25.000 request. Loại.
- **base64 trong JSON:** giữ nguyên `read_body()` → `Auth::verify` →
  `decode_json`, **không sửa một dòng nào trong file bảo mật**. Giá phải trả là
  wire phình 33%, xử lý bằng cách gói theo ngân sách bytes (§4.2). Chọn cái này.

### 3.2 Thêm và xóa

**Xóa:**

- `src/Media/ImageFetcher.php` — cả file.
- Route `POST /images/fetch` (`index.php:184`) và `handle_images()`
  (`index.php:385-407`).
- `const MAX_IMAGE_BATCH` (`index.php:32`).
- `Bootstrap::imageFetcher()` và property `$imageFetcher`
  (`src/Bootstrap.php:47,119-121`), import `use GopImport\Media\ImageFetcher`.
- Config key `allow_private_image_hosts` — khỏi `config/config.sample.ini` và
  README. Không còn nghĩa gì khi PHP không tải.

**Thêm:**

- `src/Media/ImageWriter.php` — decode, validate, ghi file. **Không một dòng
  curl, không một lần `gethostbyname`.**
- `Bootstrap::imageWriter()` theo đúng khuôn lazy-init đang có.
- Route `POST /images/upload` → `handle_image_upload()`.
- `const MAX_IMAGE_UPLOAD_BYTES = 23068672;` — 22 MB **raw sau khi decode**,
  tổng cho cả request. Xem §3.3 để biết vì sao đúng con số này.
- `const MAX_IMAGE_UPLOAD_COUNT = 40;` — chặn trên số entry, cùng tinh thần với
  `MAX_IMAGE_BATCH` cũ, để `json_decode` không phải nhá một mảng vô hạn.

`MAX_BODY_BYTES = 32 MB` giữ nguyên và vẫn là hàng rào ngoài cùng.

### 3.3 Trần một ảnh tụt từ 32 MB xuống 22 MB — có mất mát, và đây là chỗ mất

Base64 phình 4/3, nên đi ngược từ trần body ra:

```
MAX_BODY_BYTES = 32 MB  ⇒  raw tối đa = 32 × 3/4 = 24 MB
                            trừ overhead JSON  ⇒  chốt 22 MB
```

Tức `upload_site` giờ **không gửi được ảnh lớn hơn 22 MB**, trong khi
`ImageFetcher` cũ nhận tới 32 MB. Đây là **giảm năng lực thật**, không phải chi
tiết kỹ thuật, nên phải nói thẳng.

Hai đường xử lý đã cân:

- **Nâng `MAX_BODY_BYTES` lên 40 MB** để giữ đủ 32 MB. Nhưng nó là hàng rào ngoài
  cùng của **mọi** route, không riêng route ảnh, và nâng nó thì đỉnh RAM PHP của
  cả `/products/batch` cũng nới theo. Trả giá ở chỗ khác để cứu một trường hợp
  gần như không tồn tại.
- **Chấp nhận 22 MB.** Một ảnh sản phẩm trên 22 MB là bệnh lý, không phải nhu
  cầu.

Chọn cái thứ hai. Ảnh vượt trần ⇒ entry đó lỗi với message ghi rõ con số, giữ URL
gốc, sản phẩm vẫn publish — đúng luật ở §4.6.

Kéo theo một yêu cầu ở phía web: `downloadImage()` phải nhận `maxBytes`, để
`upload_site` **bỏ cuộc ngay ở 22 MB** thay vì tải xong 22 MB rồi mới ăn 400.
Chế độ `s3` vẫn dùng trần 32 MB của nó — nó không đi qua body của plugin nên
không bị ràng buộc này.

### 3.4 Tên file — quyết định vẫn hoàn toàn ở PHP

```
Slug::make(basename không extension, true)   → cắt còn 100 ký tự
+ "-" + substr(sha256(source_url), 0, 8)
+ "." + extension từ whitelist MIME
```

Ví dụ: `ao-khoac-nam-3f9a2c7b.jpg`.

Vì sao PHP giữ quyền đặt tên chứ không để web tính rồi gửi xuống: đó là tính chất
mà `ImageFetcher::fileName()` viết hẳn thành comment — *"The filename is ALWAYS
the server's decision"* — và nó là thứ chặn `../../` ghi ra ngoài `uploads`. Nếu
web tính tên thì logic `Slug::make` phải nhân đôi sang TypeScript, và hai bản sẽ
lệch nhau vào một ngày nào đó.

Cắt slug còn 100 (thay vì 120 như hiện tại) để chừa 9 ký tự cho `-hash`, tổng vẫn
dưới 120.

Extension lấy từ whitelist MIME trước, rồi mới tới đuôi trong URL, cuối cùng
fallback `jpg` — y hệt `ImageFetcher::extension()`, chép sang.

### 3.5 Idempotent

File đã tồn tại thì **không ghi lại**, trả URL cũ kèm `skipped: true`.

Một chi tiết cần có: so `filesize()` với độ dài bytes gửi lên. Khác nhau thì
**ghi đè**. Lý do là file cụt do lần chạy trước bị kill giữa `file_put_contents`
— nếu chỉ kiểm tồn tại thì mình trả về một URL trỏ vào ảnh hỏng, mãi mãi.

Đây là chỗ sửa hẳn lỗi `-1`, `-2` mà README `:625` đang phải ghi chú: cùng một
`source_url` luôn cho cùng một tên file, nên retry không sinh bản sao nữa. Một
ảnh dùng cho 10 sản phẩm cũng chỉ lưu một lần.

### 3.6 Validate — kiểm bytes, không tin client

`ImageWriter::sniff(string $raw): ?string` đọc magic bytes ở đầu file và trả về
MIME, hoặc `null`:

| Loại | Prefix |
|---|---|
| JPEG | `FF D8 FF` |
| PNG | `89 50 4E 47 0D 0A 1A 0A` |
| GIF | `47 49 46 38` |
| WEBP | `52 49 46 46` … `57 45 42 50` (byte 8-11) |
| AVIF | `66 74 79 70 61 76 69 66` (byte 4-11) |
| BMP | `42 4D` |

`null` ⇒ từ chối entry đó với `error`, các entry khác trong request vẫn chạy.
Nếu `content_type` client khai không thuộc cùng loại với thứ sniff ra thì lấy
**kết quả sniff**, không lấy lời khai.

Dùng bảng prefix chứ không dùng `getimagesizefromstring` vì `IMAGETYPE_AVIF` chỉ
có từ PHP 8.1, và `finfo` không phải host rẻ nào cũng bật — cả hai đều sinh ra
"từ chối sai" trên đúng nhóm host mà tài liệu này đang cố phục vụ. Bảng prefix
thì tự mình kiểm soát và có kết quả xác định.

Prefix có thể bị giả (dán `FF D8 FF` vào đầu file bất kỳ), và điều đó **không**
thành vấn đề: extension luôn lấy từ whitelist MIME của server, client không bao
giờ chọn được `.php`. Web server không thực thi `.jpg`.

Vẫn phải nói rõ: đây **chặt hơn hôm nay**. `ImageFetcher::collect()` chỉ kiểm
`Content-Type` **do server ở xa khai**, không hề đọc bytes.

`id_multisite` giữ nguyên kiểm `ctype_digit` như `ImageFetcher::multisiteSegment()`.

### 3.7 Bộ nhớ

Decode **từng ảnh một** rồi `unset()` ngay sau khi ghi, không `array_map` decode
cả mảng.

Hai con số, và cả hai đều phải nói ra:

| Trường hợp | `$body` | mảng sau `json_decode` | ảnh đang decode | đỉnh |
|---|---|---|---|---|
| Thường — ngân sách web 16 MB | ~21,3 MB | ~21,3 MB | vài MB | **~45 MB** |
| Xấu nhất — một ảnh 22 MB đi riêng | ~29,3 MB | ~29,3 MB | 22 MB | **~81 MB** |

Plugin không boot WordPress (dùng `mysqli` trực tiếp) nên baseline thấp, và
`memory_limit` 128M chịu được cả hai. Trên host `memory_limit` 64M thì cột "xấu
nhất" **vỡ** — nhưng nó chỉ xảy ra khi catalogue có ảnh ~22 MB, và khi vỡ thì
operator nhìn thấy `php_memory_limit` ngay trên màn Sites nhờ field ở dưới.

Vì thế `/health` thêm hai field chẩn đoán:

- `max_image_upload_bytes` — trần thật của plugin.
- `php_memory_limit` — `ini_get('memory_limit')`.

**Chỉ để chẩn đoán, không tự clamp.** Hiện lên màn Sites để khi một host yếu ăn
lỗi, operator thấy ngay con số thay vì phải đoán. Tự clamp thì cần thêm cột trong
bảng `stores` và một migration, chưa cần tới.

Vượt trần ⇒ 400 `upload_too_large`, message ghi rõ trần thật, để web hạ
`GOP_IMAGE_UPLOAD_BYTES` được mà không cần đọc source.

### 3.8 `AttachmentMeta` không sửa gì

File nằm local, URL bắt đầu bằng `site_url` ⇒ `AttachmentMeta::relativePath()`
nhận ra là ảnh của chính site, `getimagesize` đọc được width/height thật, và
`_wp_attachment_metadata` được ghi đúng như hôm nay. Đây chính là lý do §2 chọn
"vẫn trong Media Library" thay vì S3.

## 4. Phía web

### 4.1 Downloader dùng chung, và guard **không** nằm trong nó

> **Sửa so với bản đầu của tài liệu này.** Bản đầu định viết SSRF guard ngay trong
> `lib/image-download.ts`. Khi vào code mới thấy `lib/outbound-url.ts` **đã tồn
> tại** và docblock của nó viết thẳng: *"One rule in one place, so the two cannot
> drift into disagreeing about what is safe"* — nó đang phục vụ image check ở bước
> preview và webhook. Viết guard mới là tạo **chỗ thứ ba**, đúng cái module đó tồn
> tại để ngăn. Nên đổi hướng: **nâng cấp `outbound-url.ts`**, không tạo bản sao.

**`lib/image-download.ts`** — tách `fetchImage()` đang private trong `lib/s3.ts`
ra, cho cả `s3` và `upload_site` dùng:

```ts
export interface DownloadedImage { sourceUrl: string; body: Buffer; contentType: string }
export class ImageDownloadError extends Error {}
export async function downloadImage(url: string, options?: { maxBytes?: number }): Promise<DownloadedImage>
```

Việc riêng của module này: **áp guard lên từng redirect hop**, và đọc body có trần.

**`lib/outbound-url.ts`** — nhận thêm `assertFetchableUrl(url)`, đứng cạnh
`blockedReason(url)` đang có. Hai hàm, hai mức, cố ý khác nhau:

- `blockedReason` (đồng bộ, đang có): chặn theo **tên** — `localhost`, dải private
  viết thẳng, `.local`, `.internal`. Bước preview cần một verdict nhanh để hiện
  thành bảng, và nó không giữ body.
- `assertFetchableUrl` (async, mới): chạy `blockedReason` trước cho khớp verdict,
  rồi **resolve DNS và kiểm mọi địa chỉ** trả về. Đây là hàm downloader dùng, vì
  downloader **giữ body** và **có** follow redirect.

**Đây là điểm rủi ro thật của cả thay đổi này, và phải làm trong cùng PR.** Hôm nay
ảnh do PHP **trên site của chính khách** tải, nên URL nội bộ chỉ với tới mạng của
khách. Chuyển sang worker thì **hạ tầng của mình** đi tải URL khách tự nhập trong
CSV. Mà `fetchImage()` **không có guard nào**, cũng không kiểm content-type — trong
khi `ImageFetcher::reject()` thì có. Bỏ `ImageFetcher` mà không bù lại là tự giảm
bảo mật.

| Kiểm tra | Chi tiết |
|---|---|
| Scheme | chỉ `http` / `https` |
| SSRF | `dns.lookup(host, {all:true})`, **mọi** địa chỉ trả về phải là public |
| Dải chặn | `0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16` (metadata AWS/GCP), `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`, `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8` |
| IPv4-mapped IPv6 | bung 8 nhóm 16-bit rồi unwrap — xem §4.1.1, đây là chỗ có bug thật |
| Redirect | `redirect: "manual"`, tự follow tối đa 3 hop, **kiểm lại từng hop** |
| Content-Type | phải `image/*` |
| Trần | 32 MB cho `s3`; `upload_site` truyền `maxBytes` = 22 MB để bỏ cuộc sớm |
| Timeout | 30s |

Phần redirect **khá hơn** plugin cũ: `CURLOPT_FOLLOWLOCATION` chỉ kiểm URL đầu rồi
follow mù, nên một URL công khai redirect về `169.254.169.254` đi qua được.

Hạn chế nhận: vẫn còn TOCTOU (DNS rebinding) giữa lúc resolve và lúc `fetch`. Đóng
nó cần pin connection vào IP đã kiểm, `fetch` của Node không cho. Plugin cũ y hệt
nên không phải hồi quy — chỉ là chưa đóng.

#### 4.1.1 Bug thật: `[::ffff:127.0.0.1]` không bị chặn

Bản đầu viết check dạng regex trên chuỗi: `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/`.
Nó **không bao giờ trúng**, vì parser URL của WHATWG viết lại phần dotted thành hex:

```
new URL("http://[::ffff:127.0.0.1]/").hostname  →  [::ffff:7f00:1]
```

Tức check khớp cái **người ta gõ**, còn chương trình giữ **giá trị khác**. Kết quả:
loopback đi qua guard. `tests/images-staging.ts` bắt được.

Cách sửa: `ipv6Groups()` bung địa chỉ thành 8 nhóm 16-bit, rồi nếu 5 nhóm đầu bằng 0
và nhóm thứ 6 là `ffff` (mapped) hoặc `0` (compatible) thì lấy 32 bit cuối làm IPv4
và áp luật IPv4. `::` và `::1` rơi vào đây luôn nên không cần case riêng — chúng
unwrap thành `0.0.0.0` và `0.0.0.1`, đã bị `0.0.0.0/8` chặn.

#### 4.1.2 Escape hatch: allowlist theo host, **không** phải bật/tắt toàn bộ

> **Sửa so với bản đầu.** Bản đầu chỉ định `GOP_ALLOW_PRIVATE_IMAGE_HOSTS=1`.
> Không dùng được, vì hai lý do độc lập.

`tests/images-staging.sh` chạy fake image host trong container, hostname resolve ra
IP private (dải Docker). Bật cờ toàn cục thì suite chạy với guard **tắt** — và
assertion quan trọng nhất của nó (*URL công khai redirect về `169.254.169.254` bị
chặn ở hop thứ hai*) sẽ **pass dù guard có tồn tại hay không**. Test vô nghĩa.

Và nó cũng là công cụ sai cho khách: ai có image server nội bộ thật thì cần đúng
**một** host đi qua được, còn `allow_private_image_hosts` của plugin buộc họ tắt
check cho mọi URL trong mọi run.

Nên có **hai** biến:

| Biến | Nghĩa |
|---|---|
| `GOP_IMAGE_HOST_ALLOWLIST` | danh sách hostname, phân cách phẩy, **khớp chính xác** (không khớp hậu tố: `example.com` không được cho qua `example.com.attacker.net`). Đây là thứ khách dùng, và là thứ test dùng |
| `GOP_ALLOW_PRIVATE_IMAGE_HOSTS=1` | tắt hẳn. Chỉ cho local dev |

Suite chạy với allowlist đúng một host của fixture, nên **mọi địa chỉ viết thẳng
trong test vẫn bị chặn** — test đỏ nếu guard hỏng.

**Tác dụng phụ lên chế độ `s3`:** nó cũng được guard và kiểm content-type. Là sửa
lỗi, nhưng **có đổi hành vi**: run S3 trước đây up trang HTML báo lỗi của CDN lên
bucket dưới dạng `.jpg`, giờ ảnh đó fail và giữ URL gốc. Phải ghi vào README.

### 4.2 `lib/image-upload.ts` — mới

bytes → site. Một việc, tách riêng để test được độc lập:

- Gói entry vào request theo **ngân sách bytes**, không theo số lượng: mặc định
  16 MB raw (`GOP_IMAGE_UPLOAD_BYTES`), và tối đa 40 entry.
- Một ảnh lớn hơn ngân sách thì đi riêng một request. Lớn hơn cả trần plugin thì
  fail entry đó với message nói rõ, không gửi.
- Request upload **tuần tự trong mỗi lane**, đúng như vòng `for` hôm nay
  (`lib/images.ts:66`) ⇒ số request PHP đồng thời vẫn bằng `threads`, **nhưng mỗi
  request giờ là một lần ghi đĩa local thay vì tới ~100s curl**. Không cần
  semaphore toàn cục, và không thêm khái niệm mới nào cho operator.

### 4.3 `lib/images.ts` — điều phối

`images.ts` đang 191 dòng. Nhồi thêm download lane + packing + cache vào đó là ba
việc trong một file. Nên chia như trên, còn `images.ts` giữ đúng vai điều phối:
`collectUrls`, cache theo run, chọn mode, `rewrite` sản phẩm.

Cache theo run:

```ts
stageImages(products, options, client, s3, cache?: Map<string, Promise<StagedImage>>)
```

Worker tạo **một** Map cho cả run và truyền vào cả hai call site (`:467` và
`:682`). Map lưu `Promise` chứ không lưu giá trị, để hai lane cùng gặp một URL thì
lane thứ hai `await` chứ không tải lần nữa.

Chi tiết bắt buộc: **chỉ cache thành công**. Thất bại thì xóa khỏi Map, để batch
sau còn thử lại. Không có luật này thì một cú CDN hiccup ở batch đầu đầu độc
nguyên cả run.

Hôm nay Map là per-batch, nên một logo dùng chung 5.000 sản phẩm bị tải lại ở
**mỗi** batch. Sau thay đổi: một lần cho cả run.

### 4.4 Gate version — `lib/plugin-version.ts`, **không** phải `plugin-support.ts`

> **Sửa so với bản đầu, sau một bug thật.** Bản đầu định đặt gate vào
> `lib/plugin-support.ts`, cạnh hai gate đang có. Làm đúng thế thì **worker crash
> ngay lúc khởi động**: file đó mở đầu bằng `import "server-only"`, mà package này
> throw dưới Node thuần. Cả `lib/stores.ts` và `lib/jobs.ts` đều đã có comment
> *"Do NOT import `server-only` here — this module is in the worker's import graph"*
> — tức repo đã cảnh báo đúng chuyện này và mình vẫn bước vào. `tests/e2e.sh` bắt
> được ở stage 1.
>
> Ngoài worker, wizard cũng cần gate, và wizard là **Client Component** — cũng
> không với tới `server-only` được. Hai lý do độc lập cùng chỉ về một chỗ.

Nên gate sống ở **`lib/plugin-version.ts`** (client-safe, không chạm `node:fs`):

```ts
export const IMAGE_UPLOAD_VERSION = "3.9.0";
export function supportsImageUpload(pluginVersion: string | null | undefined): boolean
export function imageUploadSupport(pluginVersion: string | null): PluginSupport
```

Nhận **chuỗi version** chứ không nhận `Store`, để không kéo theo dependency của
`lib/stores.ts` — đó chính là thứ làm nó với được từ wizard. `PluginSupport` cũng
chuyển sang đây; `plugin-support.ts` re-export lại để phía server vẫn có một chỗ
để tra.

Chặn ở **ba** chỗ:

1. **Worker, trước khi gửi bất cứ gì** — ngay cạnh khối resolve S3
   (`worker/index.ts`): run `failed` với lý do rõ và **không gửi một byte nào**,
   thay vì mọi batch fail rồi summary vẫn ghi "completed". Y hệt pattern
   S3-missing đã có ở đó.
2. **Wizard** (`app/(app)/import/options-step.tsx`): site cũ thì `upload_site`
   không chọn được, kèm Alert **liệt kê tên từng site và version của nó** — báo
   một site đầu tiên thôi thì update 4 site mất 4 lượt thử.
3. **Route handler** (`app/api/import/route.ts`): đặt ngay sau vòng kiểm tra site
   đang có, trước khi tạo job nào — đúng kỷ luật *"check EVERY site before
   creating any job"* mà file đó đã tự viết. Trả 409 `plugin_too_old`, và **nêu
   tên mọi site** vi phạm cùng lúc.

Không phải "defence in depth" cho vui. Route lạ trả 404 `unknown_route`, nên không
gate thì operator nhìn thấy 5.000 dòng lỗi 404 chứ không nhìn thấy câu "plugin của
site này cũ rồi" — và tệ hơn, sản phẩm vẫn publish với link của nhà cung cấp, tức
đúng cái mà chế độ này tồn tại để tránh.

### 4.5 `lib/gop-client.ts`

Bỏ `fetchImages()` (`:509`), thay bằng:

```ts
async uploadImages(entries: Array<{
  source_url: string; content_type: string; bytes: string;
  file_name?: string; id_multisite?: string;
}>): Promise<Array<{ ok: boolean; url?: string; source_url?: string;
                     error?: string; skipped?: boolean }>>
```

Response giữ đúng shape cũ cộng `skipped`, nên code map URL trong `images.ts` gần
như không đổi.

Ghi chú bộ nhớ phía Node: `JSON.stringify` + HMAC đi qua cả payload, nên Node giữ
khoảng 2× payload. 16 MB raw ⇒ ~21 MB base64 ⇒ ~45 MB. Chấp nhận được cho worker.

### 4.6 Báo lỗi tách làm hai loại

Hôm nay mọi lỗi ảnh dồn một rổ `stage: "images"` (`worker/index.ts:469`).
Giờ thêm `reason`:

- `reason: "download"` → nguồn ảnh chết: 404, timeout, không phải ảnh, bị SSRF
  guard chặn. **Lỗi của feed / supplier.**
- `reason: "upload"` → site không ghi được: hết đĩa, sai permission, quá trần.
  **Lỗi của site.**

Chính sách không đổi: một ảnh lỗi thì giữ URL gốc, ghi log, **sản phẩm vẫn
publish**. Đó là luật đang có và không có lý do gì để đổi.

### 4.7 Dọn

`lib/import-options.ts:211` — warning *"Copying images into the site with more
than 16 parallel batches tends to choke the target site itself"* hết đúng, vì PHP
không tải nữa. Thay bằng warning về băng thông worker, hoặc bỏ. Không được để
nguyên: một cảnh báo sai còn tệ hơn không có cảnh báo.

## 5. Test

Ba tầng, ba lý do khác nhau. Chỗ này **lệch so với bản đầu**: bản đầu định nhồi
phần web vào `tests/isolation.sh`, nhưng suite đó dựng Postgres + Redis + `next
build` và mất hàng phút, trong khi thứ cần test ở đây là một downloader, một hàm
số học và một `Map` — không có gì nằm trên request path. **Suite mất mười lăm phút
là suite bị bỏ không chạy**, nên nó thành một suite nhẹ riêng.

**Plugin** — `GPM_toshstack/tests/integration.php`, gọi `ImageWriter` trực tiếp,
không cần mạng (điều mà `ImageFetcher` không bao giờ làm được):

- ghi đúng `uploads/YYYY/MM`, tên `slug-<hash8>`, diacritics được slugify;
- **lần thứ hai cùng `source_url` ⇒ `skipped: true`, không sinh `-1`**;
- file cụt (filesize lệch) ⇒ ghi đè;
- magic bytes không phải ảnh ⇒ entry đó lỗi, **entry sau nó vẫn ghi**;
- `content_type` khai sai ⇒ lấy kết quả sniff (PNG khai là JPEG ⇒ lưu `.png`);
- `id_multisite` không phải digit ⇒ bỏ segment; `file_name` = `../../wp-config.php`
  ⇒ server tự đặt tên, không có `..`, không có `.php`;
- ảnh vừa ghi sinh `_wp_attachment_metadata` **thật** với width/height;
- bảng sniff nhận đúng 6 định dạng và từ chối HTML, PDF, và chuỗi quá ngắn.

**Web** — `tests/images-staging.sh` + `tests/images-staging.ts` (**mới**), chỉ cần
fake image host, plugin được **stub**:

`tests/images.py` đã là fake host kiểu ROUTES **có đếm hit** (`/_hits`) — dùng luôn
để assert "một ảnh chỉ tải đúng một lần cho cả run", tức đo ở **phía host** chứ
không tin sổ sách của app. Thêm route: `/to-metadata.jpg`, `/to-loopback.jpg`
(redirect vào nội bộ), `/to-ok.jpg` (redirect hợp lệ, **phải** vẫn follow),
`/enormous.jpg` (Content-Length khổng lồ).

Assert: guard chặn `127.0.0.1`, `169.254.169.254`, `10.x`, `[::1]`, `[fd00::1]`,
`[::ffff:127.0.0.1]`, `file://`, tên không resolve được; redirect vào nội bộ bị chặn
ở **hop thứ hai** còn redirect thường **vẫn follow**; 200-trả-HTML bị từ chối;
Content-Length quá cỡ bị từ chối **trên header**; `maxBytes` được tôn trọng; số học
packing; cache theo run tải một lần; **URL fail không bị cache** nên batch sau thử
lại; `reason` phân loại đúng download vs upload; hai lane đua trên cùng ảnh chỉ tải
một lần; `keep_remote` không tải gì; `s3` không có credential thì refuse.

Guard **giữ nguyên bật** trong suite này, qua allowlist một host — xem §4.1.2.

**E2E** — `tests/e2e.sh`, plugin PHP thật qua HTTP thật. Đây là thứ **duy nhất**
với tới được **đường dây** giữa hai nửa, và đường dây là chỗ thiết kế này ít hiển
nhiên nhất: body gần như toàn base64, mà HMAC ký **toàn bộ** body. Cần thêm vào
harness: một container `images.py`, một `wordpress_root` **ghi được**
(`/app/wp` — để nguyên thì `dirname(__DIR__, 4)` ra `/` của container), và
`GOP_IMAGE_HOST_ALLOWLIST`.

Assert:

- **ảnh 1 MB** sống sót qua base64 + HMAC — fixture 20 byte sẽ pass dù việc ký có
  bao body hay không, nên kích cỡ ở đây là load-bearing;
- URL trả về nằm trên chính site, tên có hash của source URL;
- **gửi lại ⇒ `skipped: true` và URL y nguyên** — đây cũng là bằng chứng từ bên
  ngoài rằng lần đầu **đã thật sự ghi file**, không cần chọc vào filesystem của
  container;
- HTML khai `image/jpeg` bị **site** từ chối;
- `POST /images/fetch` trả **404 `unknown_route`** — assert theo `status` và `code`,
  **không** theo câu chữ: test khớp chuỗi sẽ đỏ ngày ai đó viết lại câu thông báo,
  trong khi một build âm thầm trả 200 thì vẫn pass;
- một run `upload_site` đầu-cuối publish cả hai sản phẩm, ảnh chết giữ URL gốc.

**Gating**: site 3.8.0 + `upload_site` ⇒ run `failed` ngay, không gửi byte nào.

## 6. Release và thứ tự deploy

Plugin **không có cơ chế tự cập nhật** — khách cài tay từ zip. Nên thứ tự quan
trọng:

1. **Web lên trước.** Nó gate ở `>= 3.9.0` nên `upload_site` bị từ chối với câu
   "update plugin trên site này" — run bị chặn, nhưng **không có gì vỡ âm thầm**.
2. Khách update plugin từng site.
3. `upload_site` chạy lại, lần này web tải ảnh.

Ngược lại — plugin lên trước ở một site trong khi web còn bản cũ — thì mọi run
`upload_site` ăn 404 cho từng ảnh. Tránh.

Release checklist plugin:

- `version.txt` → `3.9.0`;
- header trong `gop-import.php`;
- `readme.txt`;
- `./build.sh` → `dist/gop-import-3.9.0.zip`.

**Không cần sửa chuỗi version nào bên web:** `expectedPluginVersion()`
(`lib/plugin-version.server.ts`) đọc thẳng `version.txt` của GPM_toshstack, nên
cảnh báo "site này chạy bản cũ" tự đúng theo.

## 7. Docs phải sửa — đã sửa

**README của web** (số dòng dưới đây là của file này, không phải README plugin):

- bảng image handling (~`:251`) — mô tả lại `upload_site`;
- mục *"What retrying costs"* (~`:625`) nói retry để lại bản sao ảnh trong
  uploads — **hết đúng sau §3.5**, phải viết lại chứ không xóa: nó là ghi chú
  người ta từng dựa vào;
- ghi nhận thay đổi hành vi của chế độ `s3` ở §4.1 (giờ từ chối ảnh không phải
  ảnh thật);
- ghi trần mới 22 MB mỗi ảnh cho `upload_site` (§3.3);
- known-gaps: TOCTOU DNS chưa đóng.

**README của plugin** (`GPM_toshstack/README.md`, `readme.txt`): thay mục
`/images/fetch` bằng `/images/upload`, bỏ `allow_private_image_hosts`, và nói rõ
plugin **không còn gọi mạng ra ngoài** — đó là điểm bán được, không chỉ là chi
tiết nội bộ.

## 8. Một ràng buộc khi viết code phía web

`AGENTS.md` của repo web ghi: bản Next.js này **có breaking change so với những gì
model đã học**, phải đọc guide trong `node_modules/next/dist/docs/` trước khi viết
code. Việc này áp vào phần sửa `options-step.tsx` và route handler ở §4.4 — đọc
guide trước, đừng viết theo quán tính.

## 9. Ngoài phạm vi

- **Không** đổi `keep_remote` (FIFU) — không liên quan.
- **Không** thêm route probe "ảnh nào đã có trên site rồi" để bỏ luôn cả bước
  tải. Hôm nay cũng tải lại giữa các run, nên đó là tính năng mới, không phải
  phần của việc sửa tải PHP.
- **Không** sinh các size ảnh resize. `AttachmentMeta` cố tình không làm, và lý
  do vẫn đúng: 0,3–2 giây CPU mỗi ảnh.
- **Không** tự clamp ngân sách theo `php_memory_limit` của site (§3.7).


## 10. Kết quả

| Suite | Kết quả |
|---|---|
| `GPM_toshstack` PHP lint (8.1) | 45 file, sạch |
| `GPM_toshstack/tests/integration.php` | **95/95** (86 trước, +9 cho `ImageWriter`) |
| `tests/images-staging.sh` | **41/41** |
| `tests/e2e.sh` | **95/95** |
| `tsc` / `eslint` / `next build` | sạch cả ba |

`next build` ở đây không phải nghi thức: §4.4 dịch một gate **qua** ranh giới
`server-only` để wizard với tới được, và chỉ có build mới chứng minh một Client
Component không kéo theo code server. `tsc` không bắt được chuyện đó.

**Hai bug do test bắt, không phải do đọc lại code:**

1. `[::ffff:127.0.0.1]` đi qua guard — §4.1.1.
2. Worker crash lúc khởi động vì `server-only` — §4.4.

Cả hai đều là loại lỗi mà review bằng mắt sẽ bỏ qua: một cái nằm ở chỗ parser viết
lại chuỗi sau lưng, một cái chỉ nổ khi tiến trình thật khởi động.

**Còn hở, đã ghi vào README known gaps:**

- **DNS rebinding** chưa đóng, ở cả đường download và preview check. Cần pin
  connection vào IP đã kiểm, `fetch` của Node không cho. Plugin cũ hở y hệt.
- **Trần 22 MB/ảnh** là giảm năng lực so với 32 MB, và chưa quan sát thấy trường hợp
  thật nào chạm phải.
- **Đổi hành vi của `s3`** (giờ từ chối ảnh không phải ảnh thật) đúng bởi cấu trúc,
  không bởi assertion riêng.

**Thứ tự deploy** — §6, và nó quan trọng: **web lên trước**, rồi khách update plugin.
Plugin không có cơ chế tự cập nhật.
