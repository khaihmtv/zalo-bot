# 🤖 Zalo Bot

Gửi tin nhắn Zalo tự động qua Playwright + BullMQ Queue.

## Yêu cầu

- Node.js >= 18
- Redis đang chạy (`redis-server`)

## Cài đặt

```bash
npm install
npx playwright install chromium
```

## Chạy

```bash
npm start
```

Truy cập: http://localhost:3000

---

## API

### `GET /qr`
Hiển thị QR code để quét đăng nhập Zalo lần đầu.  
Sau khi đăng nhập, session sẽ được lưu vào `session.json` và tự dùng lại cho các lần sau.

### `GET /status`
Kiểm tra trạng thái bot.
```json
{
  "loggedIn": true,
  "sessionExists": true,
  "queueReady": true
}
```

### `POST /send`
Gửi tin nhắn cho một người dùng Zalo.

**Request:**
```json
{
  "to": "Tên người dùng Zalo",
  "message": "Nội dung tin nhắn"
}
```

**Response:**
```json
{
  "status": "queued",
  "jobId": "1",
  "to": "Tên người dùng Zalo",
  "message": "Nội dung tin nhắn"
}
```

**Ví dụ với curl:**
```bash
curl -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -d '{"to": "Nguyễn Văn A", "message": "Xin chào!"}'
```

### `GET /logout`
Đăng xuất và xóa session.

---

## Luồng hoạt động

```
POST /send
    │
    ▼
Queue (Redis + BullMQ)
    │
    ▼
Worker (nhận job)
    │
    ▼
Playwright tìm kiếm người dùng → click → gõ tin nhắn → Enter
```

---

## Lần đầu chạy

1. Chạy `npm start`
2. Mở http://localhost:3000/qr
3. Quét QR bằng Zalo điện thoại
4. Chờ terminal in `Đăng nhập thành công ✓`
5. Bắt đầu gọi `POST /send`

## Các lần sau

Session đã được lưu trong `session.json`, bot tự đăng nhập, không cần quét QR lại.
