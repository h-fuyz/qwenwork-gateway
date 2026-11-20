#!/usr/bin/env bash
# QwenWork 团队网关云服务器一键部署脚本（Ubuntu 22.04/24.04 / Debian 12）
# 用法：以 root 在服务器上执行  bash deploy/deploy.sh
set -euo pipefail

APP_DIR=/opt/qwenwork-gateway
DATA_DIR=/var/lib/qwenwork-gateway
SERVICE=qwenwork-gateway
RUN_USER=qwg

echo "==> 1/6 安装 Node.js 22 与 Nginx"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v
apt-get install -y nginx || true

echo "==> 2/6 创建运行用户与数据目录（低权限、无登录 shell）"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
mkdir -p "$DATA_DIR" "$DATA_DIR/tmp" "$DATA_DIR/creds"
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"
chmod 700 "$DATA_DIR/creds"

echo "==> 3/6 部署代码到 $APP_DIR"
mkdir -p "$APP_DIR"
# 假定脚本从仓库根目录执行；也可改成 git clone
rsync -a --delete --exclude '.git' --exclude 'test' --exclude 'deploy' \
  "$(dirname "$0")/../"/ "$APP_DIR/"
chown -R "root:$RUN_USER" "$APP_DIR"
chmod -R o-rwx "$APP_DIR"

echo "==> 4/6 语法自检 + 冒烟测试"
cd "$APP_DIR"
node --check bin/qwenwork-gateway.mjs
node test/smoke.mjs >/dev/null 2>&1 || { echo "冒烟测试失败，中止部署"; exit 1; }
echo "    冒烟测试通过"

echo "==> 5/6 安装 systemd 服务"
install -m 644 "$APP_DIR/deploy/qwenwork-gateway.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE"
sleep 2
systemctl --no-pager -l status "$SERVICE" | head -5

echo "==> 6/6 完成"
cat <<'EOF'

后续步骤：
  1) 配置 Nginx TLS 反代：
     cp deploy/nginx-qwg.conf /etc/nginx/sites-available/qwg.conf
     （改 server_name 与证书路径）→ ln -s 到 sites-enabled → nginx -t && systemctl reload nginx
  2) 注册团队成员（见 DEPLOY.md「成员注册」三种方式）
  3) 成员客户端配置：qwenwork-gateway print-config <key> https://qwg.your-corp.com
EOF
