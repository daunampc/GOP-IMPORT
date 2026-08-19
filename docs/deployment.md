# Chạy production trên easyobot.com

Ngày: 2026-08-19

Tài liệu viết bằng tiếng Việt vì người vận hành đọc nó. **Mọi lệnh và mọi biến môi
trường vẫn là tiếng Anh.**

Giả định: một VPS Ubuntu 22.04/24.04, quyền `sudo`, domain `easyobot.com` đã trỏ A
record về IP của máy.

---

## 0. Ba điều phải biết trước khi bắt đầu

### 0.1 Redis là BẮT BUỘC, không phải tùy chọn

App cần **PostgreSQL và Redis**, không chỉ Postgres. Postgres là hệ thống lưu trữ
(account, site, run, kết quả từng dòng); Redis giữ **queue, cờ Stop, và kênh phát log
trực tiếp**.

Thiếu Redis thì app vẫn khởi động được nhưng **mọi job nằm mãi ở trạng thái "Queued"**
— màn hình không báo lỗi gì, chỉ đứng im. Đây là cách deploy sai phổ biến nhất.

### 0.2 Phải chạy HAI process

`next start` **và** worker. Không có worker thì y như thiếu Redis: job không bao giờ
chạy. Xem `ecosystem.config.js`.

### 0.3 Plugin hiện đang nhận MỌI key — phải sửa trước khi bán

Trong `GPM_toshstack/gop-import.php`:

```php
if (!defined('GOP_IMPORT_APP_URL')) {
    define('GOP_IMPORT_APP_URL', '');
}
```

Chuỗi rỗng nghĩa là **không kiểm tra gì cả**: key nhập vào được lưu và chấp nhận ngay
trên site, không hỏi server nào. Comment trong chính file đó viết: *"a build in this
state accepts ANY key. Do not ship one to a customer."*

Trước khi phát hành zip cho khách:

```php
define('GOP_IMPORT_APP_URL', 'https://easyobot.com');
```

rồi `./build.sh` lại. Sau đó plugin sẽ gọi về `POST /api/license/activate` và
`/api/license/verify` trên easyobot.com.

---

## 1. Cài đặt máy

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx postgresql redis-server
```

Node 22 LTS (app cần tối thiểu Node 20.9):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

pnpm và PM2:

```bash
sudo npm install -g pnpm pm2
```

Kiểm tra:

```bash
node -v && pnpm -v && pm2 -v && psql --version && redis-cli ping
```

`redis-cli ping` phải trả `PONG`.

---

## 2. PostgreSQL

Tạo user và database riêng cho app. **Đổi mật khẩu bên dưới thành mật khẩu thật.**

```bash
sudo -u postgres psql -c "CREATE USER easyobot WITH PASSWORD 'DOI_MAT_KHAU_NAY';"
sudo -u postgres psql -c "CREATE DATABASE gop_import_product OWNER easyobot;"
```

Kiểm tra đăng nhập được:

```bash
PGPASSWORD='DOI_MAT_KHAU_NAY' psql -h 127.0.0.1 -U easyobot -d gop_import_product -c '\conninfo'
```

Tên `gop_import_product` là mặc định app tự dùng khi không có `DB_DATABASE` — đặt
đúng tên đó cho khớp, hoặc đặt tên khác rồi khai trong `.env`.

**Redis không cần cấu hình gì thêm** cho một máy đơn: nó chỉ nghe trên `127.0.0.1`.
Nếu Redis nằm máy khác thì phải đặt `requirepass` và mở firewall — Redis không có
xác thực mặc định.

---

## 3. Lấy code và cài dependency

```bash
sudo mkdir -p /var/www && sudo chown "$USER" /var/www
git clone <repo> /var/www/easyobot
cd /var/www/easyobot
pnpm install --frozen-lockfile
```

Thư mục log cho PM2:

```bash
sudo mkdir -p /var/log/easyobot && sudo chown "$USER" /var/log/easyobot
```

---

## 4. Biến môi trường

```bash
cd /var/www/easyobot
cp .env.example .env
chmod 600 .env
```

Sinh hai khoá:

```bash
echo "STORE_ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "JWT_SECRET=$(openssl rand -hex 32)"
```

`.env` tối thiểu:

```ini
# --- Postgres
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USERNAME=easyobot
DB_PASSWORD=DOI_MAT_KHAU_NAY
DB_DATABASE=gop_import_product

# --- Redis
REDIS_URL=redis://127.0.0.1:6379

# --- Khoá
# 32 byte hex. Mã hoá api_secret của từng site và secret key S3 trước khi vào DB.
# MẤT KHOÁ NÀY = mọi site đã kết nối phải nhập lại secret. Backup riêng, ngoài máy.
STORE_ENCRYPTION_KEY=<openssl rand -hex 32>
JWT_SECRET=<openssl rand -hex 32>

# --- Domain
# PHẢI khớp CHÍNH XÁC origin công khai, kể cả https và không có dấu / ở cuối.
# Sai một ký tự thì better-auth từ chối mọi lần đăng nhập với INVALID_ORIGIN, và
# lỗi hiện ra trông như "sai mật khẩu".
BETTER_AUTH_URL=https://easyobot.com
APP_URL=https://easyobot.com

# --- Phiên bản plugin app kỳ vọng
# Trên máy dev, app đọc version.txt từ checkout GPM_toshstack bên cạnh. Trên server
# không có checkout đó, nên không khai biến này thì màn hình Sites báo mãi "không đọc
# được phiên bản plugin hiện tại" và cảnh báo site chạy bản cũ IM LẶNG BIẾN MẤT.
# Phải sửa tay mỗi lần phát hành plugin mới.
GOP_PLUGIN_VERSION=3.10.0

# --- Worker
WORKER_CONCURRENCY=4
```

Các biến tinh chỉnh ảnh (không bắt buộc, xem README mục "Copying images into a site"):

```ini
# Số ảnh tải đồng thời cho TOÀN BỘ process. Mặc định 16.
# GOP_IMAGE_DOWNLOAD_LANES=16

# Byte ảnh thô mỗi request upload. Mặc định 24 MB.
# GOP_IMAGE_UPLOAD_BYTES=25165824
```

---

## 5. Tạo schema

```bash
cd /var/www/easyobot
./node_modules/.bin/tsx --env-file=.env db/migrate.ts
```

**Không dùng `pnpm db:migrate`** ở đây. Script đó là `tsx db/migrate.ts` — không có
`--env-file`, nên nó chạy với môi trường rỗng và `connectionString()` lặng lẽ rơi về
`postgresql://postgres:@localhost:5432/gop_import_product`. Trên máy có sẵn database
tên đó, migration sẽ chạy vào **database sai** mà không báo gì.

---

## 6. Build

```bash
cd /var/www/easyobot
pnpm build
```

---

## 7. PM2

`ecosystem.config.js` đã có trong repo. Kiểm tra `ROOT` ở đầu file trỏ đúng
`/var/www/easyobot`, rồi:

```bash
cd /var/www/easyobot
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

`pm2 startup` in ra một lệnh `sudo env ...` — chạy lệnh đó để PM2 tự bật lại sau khi
máy reboot. `pm2 save` phải chạy **sau** khi hai app đã lên, vì nó lưu danh sách hiện
tại.

Kiểm tra:

```bash
pm2 status
pm2 logs easyobot-worker --lines 50
```

Worker khoẻ thì log im lặng và không restart lặp lại. `pm2 status` mà thấy cột
`restart` tăng dần là nó đang crash-loop — gần như luôn là `.env` sai.

---

## 8. Nginx + HTTPS cho easyobot.com

```bash
sudo tee /etc/nginx/sites-available/easyobot.com >/dev/null <<'NGINX'
server {
    listen 80;
    server_name easyobot.com www.easyobot.com;

    # CSV được upload qua đây. Mặc định của Nginx là 1 MB, một file 14.000 sản phẩm
    # vượt xa con số đó và lỗi trả về là 413 — không phải thông báo của app.
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # HAI ĐƯỜNG SSE — màn hình hoạt động và log trực tiếp của run.
    #
    # Không có khối này thì Nginx đệm response lại và người dùng thấy màn hình ĐỨNG IM
    # trong khi run vẫn chạy bình thường; rồi 60 giây sau kết nối bị cắt. Đây là lỗi
    # cấu hình nhìn giống hệt lỗi ứng dụng.
    location ~ ^/api/jobs/(stream|.*/logs/stream) {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_cache off;
        gzip off;
        chunked_transfer_encoding on;

        # Một run có thể kéo dài hàng giờ và kết nối này phải sống suốt thời gian đó.
        proxy_read_timeout 24h;
        proxy_send_timeout 24h;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/easyobot.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Cấp chứng chỉ:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d easyobot.com -d www.easyobot.com
```

Certbot tự sửa file trên thành 443 và thêm redirect từ 80. Sau khi xong, `curl -I
https://easyobot.com` phải trả 200 hoặc 307.

---

## 9. Kiểm tra thật

1. Mở `https://easyobot.com` — trang đăng nhập hiện ra.
2. Đăng ký account đầu tiên tại `/sign-up`.
3. Thêm một site ở màn hình Sites và bấm kiểm tra kết nối. Nó gọi `GET /health` của
   plugin và phải trả về phiên bản, PHP, MySQL, và trạng thái licence.
4. Chạy một import **3 sản phẩm** trước khi chạy 5.000. Nếu job đứng ở "Queued" thì
   worker chưa chạy hoặc chưa thấy Redis — `pm2 logs easyobot-worker`.
5. Mở màn hình log trực tiếp của run đó. Nếu nó không tự cập nhật, khối SSE ở §8 sai.

---

## 10. Vận hành

**Deploy bản mới:**

```bash
cd /var/www/easyobot
git pull
pnpm install --frozen-lockfile
./node_modules/.bin/tsx --env-file=.env db/migrate.ts
pnpm build
pm2 reload easyobot-web
pm2 reload easyobot-worker
```

`pm2 reload` cho worker vẫn cắt ngang run đang chạy. Batch đã gửi đi thì site khách
vẫn ghi, và app đánh dấu là `request_timeout` — không mất dữ liệu, nhưng nên deploy
lúc không có run lớn.

**Backup — hai thứ, và thứ hai quan trọng hơn người ta tưởng:**

```bash
# Database
pg_dump -h 127.0.0.1 -U easyobot gop_import_product | gzip > backup-$(date +%F).sql.gz
```

Và **`STORE_ENCRYPTION_KEY`, lưu ở nơi khác máy này.** Mất nó thì bản dump Postgres
vẫn còn nguyên nhưng `api_secret` của mọi site và secret key S3 của mọi account
không giải mã được nữa — khách phải nhập lại toàn bộ.

**Khi nào cần tinh chỉnh:** mỗi run tự log chi phí ảnh theo batch (bao nhiêu ảnh site
đã có, bao nhiêu MB tải mới, thời gian từng pha) và kết run báo trần download có bị
đụng hay không. Đọc số đó rồi mới sửa `GOP_IMAGE_DOWNLOAD_LANES` — README mục
"Copying images into a site: what makes it fast" giải thích cả hai núm và hai chỗ
phản trực giác.

---

## 11. Chưa làm trong tài liệu này

- **Firewall.** Nên `ufw allow 22,80,443` và chặn phần còn lại. Postgres và Redis đã
  chỉ nghe `127.0.0.1` nên không lộ ra ngoài, nhưng chưa được kiểm tra bằng lệnh nào ở
  trên.
- **Không có process nào chạy `pm2 logrotate`.** Log PM2 sẽ phình ra vô hạn:
  `pm2 install pm2-logrotate`.
- **Chưa có monitoring.** `pm2 status` là thủ công; một run thất bại lúc 3 giờ sáng
  không đánh thức ai. App có webhook và Telegram ở màn hình Settings — dùng chúng.
- **Chưa test trên máy thật.** Mọi lệnh ở đây đúng theo code trong repo, nhưng tài
  liệu này chưa được chạy đầu-cuối trên một VPS trắng. Bước §9 tồn tại để phát hiện
  chỗ mình sai.
