#!/usr/bin/env bash
# Swap the share-proxy container to a new image, rolling back if it doesn't
# come up healthy. Usage: deploy.sh <image>
set -euo pipefail

IMAGE="${1:?usage: deploy.sh <image>}"
DEPLOY_DIR="${DEPLOY_DIR:-/srv/deploy/photos}"
cd "$DEPLOY_DIR"

# Keep the live compose file in step with the repo
if [ -f "${GITHUB_WORKSPACE:-}/deploy/docker-compose.yml" ]; then
  cp "$GITHUB_WORKSPACE/deploy/docker-compose.yml" docker-compose.yml
  mkdir -p lan-gateway
  cp "$GITHUB_WORKSPACE"/deploy/lan-gateway/* lan-gateway/
fi

compose() {
  docker compose --env-file .env --env-file .image.env "$@"
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
cp .image.env ".image.env.predeploy-$stamp"
echo "PROXY_IMAGE=$IMAGE" > .image.env

compose up -d --no-deps share-proxy

for _ in $(seq 1 30); do
  state=$(docker inspect -f '{{.State.Health.Status}}' photos-share-proxy 2>/dev/null || echo missing)
  if [ "$state" = healthy ]; then
    echo "Deployed $IMAGE"
    # Keep the last 5 backups and the last 3 images
    ls -1t .image.env.predeploy-* 2>/dev/null | tail -n +6 | xargs -r rm -f
    docker image ls photos-share --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
      | sort -k2 -r | tail -n +4 | cut -d' ' -f1 | xargs -r docker image rm >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 3
done

echo "share-proxy did not become healthy ($state) - rolling back" >&2
docker logs --tail 50 photos-share-proxy >&2 || true
cp ".image.env.predeploy-$stamp" .image.env
compose up -d --no-deps share-proxy
exit 1
