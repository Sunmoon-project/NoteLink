#!/usr/bin/env bash
# AI 서버 App Service(Linux, Python) 시작 스크립트. 배포 묶음에는 startup.sh로 들어갑니다(deploy.yml).
# App Service > 구성 > 시작 명령: bash startup.sh
#
# 웹 서버(uvicorn app.main, 헬스 체크)와 ai_jobs 작업 처리기(python -m app.worker)를 함께 띄웁니다.
# 퀴즈 · 노트 · 녹음 작업은 처리기가 하므로, 웹 서버만 뜨면 앱은 켜져 보여도 작업이 쌓이기만 합니다.
#   - 둘 중 하나가 끝나면 다른 하나도 멈추고 0이 아닌 코드로 끝나 App Service가 다시 시작합니다
#     (예: 처리기가 MONGODB_URI · LLM 설정 오류로 끝나면 로그에 그 이유를 남기고 앱이 다시 시작).
#   - 멈춤 신호(SIGTERM · SIGINT)는 둘 모두에 전달하고 둘 다 끝날 때까지 기다립니다. 처리기는 처리 중인
#     작업을 끝낸 뒤 멈추고, 신호를 한 번 더 받으면 바로 끝납니다(app/worker/__main__.py).
# python은 PATH의 것을 씁니다(App Service가 배포 때 만든 가상환경). 포트는 PORT, 없으면 8000.
set -u

cd "$(dirname "$0")" || exit 1
port="${PORT:-8000}"
export PYTHONUNBUFFERED=1 # 로그가 버퍼에 남지 않고 App Service 로그 스트림에 바로 나오게

python -m app.worker &
worker=$!
python -m uvicorn app.main:app --host 0.0.0.0 --port "$port" &
web=$!
echo "AI 서버 시작: 작업 처리기 pid $worker · 웹 서버 pid $web (포트 $port)"

stopping=0
stop_all() { kill -TERM "$worker" "$web" 2>/dev/null; }
trap 'stopping=1; stop_all' TERM INT

wait -n
code=$?
if [ "$stopping" -eq 0 ]; then
  if kill -0 "$worker" 2>/dev/null; then who="웹 서버"; else who="작업 처리기"; fi
  echo "$who가 끝났습니다(코드 $code). 나머지도 멈추고 끝냅니다" >&2
  stop_all
fi
# 둘 다 끝날 때까지. 기다리는 중에 신호가 오면 trap이 다시 전달하고(처리기는 바로 끝남) 계속 기다림
while kill -0 "$worker" 2>/dev/null || kill -0 "$web" 2>/dev/null; do
  wait
done

[ "$stopping" -eq 1 ] && exit 0
[ "$code" -eq 0 ] && code=1 # 멈춤 신호 없이 끝난 것은 실패로
exit "$code"
