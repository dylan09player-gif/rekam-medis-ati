#!/usr/bin/env bash
set -e

echo "========================================================"
echo "🚀 MEMULAI DEPLOY REKAM MEDIS ATI + CLOUDFLARE TUNNEL..."
echo "========================================================"

# 1. Update & install prerequisite tools
echo "📦 Memeriksa & Menginstall Prerequisite (Docker, Git, Curl)..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git

# 2. Install Docker jika belum ada
if ! command -v docker &> /dev/null; then
    echo "🐳 Menginstall Docker..."
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt-get update -y
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    sudo usermod -aG docker $USER || true
else
    echo "✅ Docker sudah terinstall!"
fi

# 3. Setup Project Folder
PROJECT_DIR="$HOME/rekam-medis-ati"
if [ -d "$PROJECT_DIR" ]; then
    echo "🔄 Memperbarui source code project..."
    cd "$PROJECT_DIR"
    git reset --hard
    git pull origin main
else
    echo "📥 Mengunduh repository project..."
    git clone https://github.com/dylan09player-gif/rekam-medis-ati.git "$PROJECT_DIR"
    cd "$PROJECT_DIR"
fi

# 4. Jalankan Docker Compose
echo "🚀 Membangun dan Menjalankan Aplikasi + Cloudflare Tunnel..."
sudo docker compose down 2>/dev/null || true
sudo docker compose up -d --build

echo "⏳ Menunggu Cloudflare Tunnel aktif (10 detik)..."
sleep 10

echo ""
echo "================================================================="
echo "🎉 DEPLOY BERHASIL! LINK APLIKASI ANDA (BISA DIBUKA DI SEMUA WIFI):"
echo "================================================================="
TUNNEL_URL=$(sudo docker logs rekam-medis-tunnel 2>&1 | grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' | tail -n 1)

if [ -n "$TUNNEL_URL" ]; then
    echo ""
    echo "👉 $TUNNEL_URL 👈"
    echo ""
    echo "Simpan link di atas! Link ini sudah ber-SSL HTTPS dan kebal blokir WiFi."
else
    echo "Tunnel sedang starting... Cek link dengan perintah: sudo docker logs rekam-medis-tunnel"
fi
echo "================================================================="
