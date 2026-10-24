# Đề 31 - Hệ thống Thư viện Ảnh / Gallery

Project mẫu triển khai website quản lý album ảnh theo stack Node.js + MySQL + phpMyAdmin + Nginx + Prometheus + Grafana + Loki/LogQL. Log mặc định được chuyển đến Loki bằng Grafana Alloy. Có thể chọn Promtail qua profile `promtail` để tương thích cấu hình cũ; Promtail đã kết thúc vòng đời hỗ trợ.

## 1. Chức năng

- Đăng nhập khu vực quản trị bằng tài khoản cấu hình trong `.env`.
- Tạo và xóa album; phân loại album và từng ảnh theo Du lịch, Gia đình, Bạn bè, Thiên nhiên, Công việc, Ẩm thực hoặc Khác; lọc ảnh theo chủ đề.
- Upload tối đa 5 ảnh mỗi lần (JPG/JPEG, PNG, WEBP, GIF), giới hạn 10 MB/ảnh; kiểm tra MIME và chữ ký file trước khi lưu.
- Xem và xóa ảnh trong album.
- Tạo liên kết chia sẻ công khai riêng cho album hoặc từng ảnh; xem trạng thái và thu hồi liên kết khi cần.
- MySQL lưu dữ liệu; bảng `sessions` liên kết với `users` sau khi đăng nhập; ảnh và dữ liệu DB được lưu ở Docker volumes.
- Nginx làm reverse proxy, giới hạn request cơ bản và thêm security headers.
- Prometheus thu thập metrics; Grafana có sẵn datasource và dashboard; Loki lưu log; Alloy đọc file log của ứng dụng và Nginx.

Khi ứng dụng khởi động, schema cũ được cập nhật tự động để hỗ trợ danh mục riêng cho ảnh, liên kết chia sẻ ảnh và quan hệ giữa phiên đăng nhập với người dùng; dữ liệu album/ảnh hiện có được giữ nguyên. Tài khoản quản trị trong `.env` được đồng bộ vào `users`; mật khẩu được lưu dưới dạng băm scrypt.

## 2. Kiến trúc

```text
Trình duyệt
    |
    v
Nginx :8080 (reverse proxy, giới hạn request, security headers)
    |
    v
Node.js / Express :3000 ---- MySQL 8.4
    |                           |
    |                           +---- phpMyAdmin :8081 (chỉ bind localhost)
    |
    +---- /metrics ----> Prometheus :9090 ----> Grafana :3001
    |
    +---- file logs ----> Grafana Alloy ----> Loki ----> Grafana / LogQL
```

Các port quản trị/giám sát được bind vào `127.0.0.1` để không công khai trực tiếp trên mạng. Chỉ website Nginx được mở qua port `8080` theo mặc định.

## 3. Yêu cầu

- Docker Engine và Docker Compose v2 (lệnh `docker compose`).
- Kết nối Internet lần đầu để tải images và npm packages.

## 4. Khởi chạy

### Linux/macOS

```bash
cp .env.example .env
# Mở .env, đổi tất cả mật khẩu và SESSION_SECRET trước khi chạy.
docker compose up -d --build
docker compose ps
```

### Windows PowerShell

```powershell
Copy-Item .env.example .env
notepad .env
# Sau khi cập nhật mật khẩu:
docker compose up -d --build
docker compose ps
```

Chờ MySQL hoàn tất khởi tạo và ứng dụng có trạng thái `healthy`, sau đó mở các địa chỉ:

| Dịch vụ | Địa chỉ mặc định | Ghi chú |
|---|---|---|
| Website Gallery | http://localhost:8080 | Giao diện chính |
| phpMyAdmin | http://localhost:8081 | Chỉ truy cập trên máy host |
| Prometheus | http://localhost:9090 | Kiểm tra `Status > Targets` |
| Grafana | http://localhost:3001 | Đăng nhập bằng tài khoản trong `.env` |
| Loki | Không publish trực tiếp | Truy cập qua datasource Grafana |

Dùng `ADMIN_USER` và `ADMIN_PASSWORD` trong `.env` để đăng nhập Gallery. Với phpMyAdmin, dùng `MYSQL_USER` / `MYSQL_PASSWORD`. Không có mật khẩu mặc định an toàn chung, hãy dùng giá trị riêng bạn đã tự đặt trong `.env`.

## 5. Quan sát hệ thống

### Prometheus

Mở `http://localhost:9090/targets`. Target `gallery-app` phải có trạng thái `UP`. Các metric chính:

- `gallery_http_requests_total`: tổng request, phân theo method/route/status code.
- `gallery_http_request_duration_seconds`: histogram độ trễ request.
- `gallery_process_resident_memory_bytes`: RAM RSS của tiến trình Node.js.

### Loki và Nginx

Alloy gửi log ứng dụng với nhãn `job="gallery-app"` và access/error log của reverse proxy với nhãn `job="nginx"`. Trong Grafana **Explore → Loki**, dùng `{job="nginx"}` để xem log Nginx hoặc `{job="gallery-app"}` để xem log ứng dụng.

### Kiểm thử HTTP 500, metrics và cảnh báo

Endpoint thử lỗi bị tắt mặc định. Chỉ bật tạm trong môi trường kiểm thử bằng cách đặt `ENABLE_TEST_ERROR_ENDPOINT=true` trong `.env`, rồi chạy `docker compose up -d --force-recreate app`. Endpoint nằm trên Gallery qua Nginx ở port `8080`; port `8081` là phpMyAdmin nên `curl.exe -i http://localhost:8081/__test__/http-500` chỉ trả 404 và không kích hoạt alert. Endpoint thử yêu cầu đăng nhập và CSRF token, nên phải gửi `POST /api/test/500`.

Ví dụ Windows PowerShell dùng `curl.exe` và tài khoản `ADMIN_USER` / `ADMIN_PASSWORD` trong `.env`:

```powershell
$settings = @{}
Get-Content .env | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') { $settings[$matches[1]] = $matches[2] }
}
$cookieJar = Join-Path $env:TEMP 'gallery-test-cookies.txt'
$csrf = curl.exe -sS -c $cookieJar http://localhost:8080/api/csrf | ConvertFrom-Json
$body = @{ username = $settings.ADMIN_USER; password = $settings.ADMIN_PASSWORD } | ConvertTo-Json -Compress
$login = $body | curl.exe -sS -b $cookieJar -c $cookieJar `
  -H 'Content-Type: application/json' `
  -H "X-CSRF-Token: $($csrf.csrfToken)" `
  --data-binary '@-' http://localhost:8080/api/login | ConvertFrom-Json
curl.exe -i -b $cookieJar `
  -H "X-CSRF-Token: $($login.csrfToken)" `
  -X POST http://localhost:8080/api/test/500
Remove-Item $cookieJar
```

Request cuối phải trả `HTTP/1.1 500`. Hoàn tất kiểm thử thì đặt lại `ENABLE_TEST_ERROR_ENDPOINT=false` (hoặc xóa dòng này) và recreate app để endpoint bị tắt.

Sau request thử lỗi, kiểm tra:

- Prometheus: `increase(gallery_http_requests_total{status_code="500"}[15m])`
- Log ứng dụng trong Grafana Explore: `{job="gallery-app"} | json | status="500"`
- Access log Nginx trong Grafana Explore: `{job="nginx"} |= "POST /api/test/500" |= " 500 "`
- Alert **Gallery HTTP 5xx detected**: quy tắc kiểm tra số HTTP 5xx trong 15 phút gần nhất và giữ điều kiện 1 phút. Với evaluation interval 1 phút, chờ tối đa khoảng 2 phút rồi xác nhận trạng thái **Firing** trong Grafana Alerting; alert sẽ hồi phục khi mẫu 5xx rời khỏi cửa sổ 15 phút. Dashboard dùng cùng cửa sổ 15 phút để số lỗi không biến mất ngay sau 5 phút.

### Grafana

Mở `http://localhost:3001`, đăng nhập bằng `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD`. Datasource `Prometheus` và `Loki` đã được provision tự động. Vào **Dashboards → Gallery → Gallery System Overview** để xem HTTP requests/sec, số request 5xx trong 15 phút, Node heap, request duration p95 và application logs từ Loki bằng LogQL.

Quy tắc **Gallery HTTP 5xx detected** được provision tự động trong **Alerting → Alert rules → Gallery**. Quy tắc cảnh báo khi có phản hồi HTTP 5xx trong 15 phút gần nhất và duy trì trạng thái đó trong 1 phút.

Quy tắc **Gallery HTTP 5xx detected** được route đến contact point email `gallery-gmail`, dùng địa chỉ `GRAFANA_ALERT_EMAIL` trong `.env`. Để gửi bằng Gmail, điền `GRAFANA_SMTP_HOST=smtp.gmail.com:587`, `GRAFANA_SMTP_USER`, `GRAFANA_SMTP_PASSWORD` (Google App Password, không phải mật khẩu đăng nhập thường), `GRAFANA_SMTP_FROM_ADDRESS` và `GRAFANA_ALERT_EMAIL`; đặt `GRAFANA_SMTP_ENABLED=true`, rồi khởi động lại Grafana. Bảo vệ `.env` và không chia sẻ App Password.

Trong **Explore → Loki**, chọn datasource Loki và thử LogQL:

```logql
{job="gallery-app"}
```

```logql
{job="gallery-app"} |= "error"
```

```logql
{job="gallery-app"} | json | level="warn"
```

Ứng dụng không ghi mật khẩu hoặc nội dung session vào log; các đường dẫn chứa token chia sẻ được loại khỏi access log của ứng dụng.

### Chọn Promtail thay cho Alloy (tùy chọn)

Alloy là collector mặc định. Nếu cần chạy Promtail để tương thích cấu hình cũ, dừng Alloy trước để tránh gửi trùng log, rồi khởi động service theo profile:

```bash
docker compose stop alloy
docker compose --profile promtail up -d promtail
```

Trên Windows PowerShell, dùng cùng các lệnh `docker compose`. Cấu hình nằm trong `promtail-config.yml`; vị trí đọc file log được lưu ở volume `promtail_positions`. Để quay lại Alloy:

```bash
docker compose --profile promtail stop promtail
docker compose up -d alloy
```

Promtail đã kết thúc vòng đời hỗ trợ; ưu tiên Alloy cho triển khai mới.

## 6. Hardening đã cấu hình

- Secrets chỉ lấy từ `.env`, file `.env` bị Git ignore; không commit file này.
- Session dùng cookie `HttpOnly`, `SameSite=Lax`; session lưu trong MySQL và liên kết với `users` bằng khóa ngoại sau đăng nhập; session ID được tạo mới sau đăng nhập. Mật khẩu tài khoản được lưu dưới dạng băm scrypt.
- CSRF token bắt buộc với request thay đổi dữ liệu; giới hạn tần suất đăng nhập.
- Helmet security headers, CSP, tắt `X-Powered-By`, kiểm tra dữ liệu đầu vào và truy vấn SQL tham số hóa.
- Upload giới hạn kích thước, đuôi file, MIME và magic bytes; tên file được sinh ngẫu nhiên.
- Nginx giới hạn request và kích thước body; các port DB/giám sát chỉ bind vào localhost hoặc không publish.
- Container app chạy bằng user `node`, có healthcheck, `no-new-privileges` và drop Linux capabilities.
- MySQL, upload, logs, Loki, Prometheus và Grafana dùng volumes để dữ liệu tồn tại qua lần restart.

**Khi triển khai Internet thật:** cấu hình HTTPS/TLS ở Nginx, đặt `COOKIE_SECURE=true`, thay mọi secret, giới hạn quyền truy cập vào Grafana/phpMyAdmin, định kỳ cập nhật image và tạo backup DB + volume ảnh. Cấu hình hiện tại hướng đến bài thực hành/local lab; không coi HTTP thuần là cấu hình production cuối cùng.

## 7. Lệnh quản trị

```bash
# Xem log các dịch vụ
docker compose logs -f app nginx mysql

# Xem riêng pipeline giám sát
docker compose logs -f alloy loki prometheus grafana

# Dừng dịch vụ nhưng giữ dữ liệu volumes
docker compose down

# Dừng và xóa CẢ dữ liệu volumes (cẩn thận)
docker compose down -v

# Kiểm tra cú pháp compose trước khi chạy
docker compose config
```

## 8. GitHub

1. Tạo repository mới trên GitHub.
2. Giữ `.env.example`, tuyệt đối không commit `.env` hoặc mật khẩu thật.
3. Từ thư mục project, chạy:

```bash
git init
git add .
git commit -m "feat: implement gallery system with monitoring"
git branch -M main
git remote add origin https://github.com/<username>/<repository>.git
git push -u origin main
```

## 9. Lưu ý về database init

`mysql/init/001_schema.sql` chỉ chạy tự động khi MySQL khởi tạo một data volume mới. Nếu sửa schema sau khi volume đã tồn tại, hãy áp dụng migration SQL riêng; không xóa volume dữ liệu thật chỉ để chạy lại init.
