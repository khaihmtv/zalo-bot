#!/bin/bash
# Chạy 1 lần duy nhất trên VPS để chuẩn bị môi trường
# ssh vào VPS rồi: bash setup-vps.sh

set -e

echo "📦 Cài Docker nếu chưa có..."
if ! command -v docker &> /dev/null; then
  sudo yum update -y
  sudo yum install -y docker
  sudo systemctl start docker
  sudo systemctl enable docker
  sudo usermod -aG docker $USER
  echo "✅ Docker đã cài xong"
else
  echo "✅ Docker đã có sẵn"
fi

echo "📦 Cài Docker Compose plugin nếu chưa có..."
if ! docker compose version &> /dev/null; then
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  echo "✅ Docker Compose đã cài xong"
else
  echo "✅ Docker Compose đã có sẵn"
fi

echo "📁 Tạo thư mục project..."
mkdir -p ~/zalo-bot/data
touch ~/zalo-bot/data/session.json ~/zalo-bot/data/logs.json

echo ""
echo "✅ VPS đã sẵn sàng!"
echo ""
echo "👉 Việc tiếp theo:"
echo "   1. Copy file docker-compose.yml lên ~/zalo-bot/"
echo "   2. Thêm 3 Secrets vào GitHub repo:"
echo "      VPS_HOST     = IP hoặc domain của VPS"
echo "      VPS_USER     = user SSH (thường là ec2-user)"
echo "      VPS_SSH_KEY  = nội dung file ~/.ssh/id_rsa (private key)"
echo "   3. Push code lên branch main → tự động deploy"
