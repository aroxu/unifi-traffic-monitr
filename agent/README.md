# 게이트웨이 에이전트

UniFi 게이트웨이(UCG)에 설치해 클라이언트별 트래픽을 장비에서 직접 세는 Go 프로그램입니다. 수집기는 WebSocket으로 에이전트에 연결합니다. 연결되어 있는 동안에는 1초마다 실시간 데이터를 받습니다. 연결이 없을 때 에이전트는 전송하지 않고 5분 단위 기록만 `/data`에 쌓습니다. 수집기가 다시 연결하면 빠진 기록을 채웁니다.

## 측정 방식

에이전트는 커널 conntrack의 흐름별 바이트 카운터를 netlink로 읽습니다. 수집기가 연결되어 있으면 1초, 없으면 10초마다 전체 흐름 목록을 읽습니다. 흐름 종료 이벤트도 함께 받아, 두 조회 사이에 시작하고 끝난 흐름도 셉니다. UCG Fiber의 하드웨어 가속(ECM/PPE)이 켜져 있어도 conntrack 카운터가 갱신되는 것을 실측으로 확인했습니다([POC_RESULTS.md](../POC_RESULTS.md)).

- **클라이언트:** `AGENT_CLIENT_INTERFACES`(기본 `br*`)에 연결된 네트워크의 주소입니다. IP는 게이트웨이의 ARP/NDP 표로 MAC에 대응시킵니다. MAC을 찾지 못한 주소의 트래픽은 `unattributed`로 따로 모읍니다.
- **인터넷:** 상대가 WAN 인터페이스로 나가는 주소인 트래픽입니다. WAN은 기본 경로가 있는 인터페이스입니다.
- **LAN(게이트웨이 경유):** 상대가 게이트웨이 자신이거나, 다른 내부 네트워크 또는 VPN 경로에 있는 트래픽입니다. 서로 다른 네트워크 사이의 통신은 양쪽 클라이언트에 모두 기록합니다.
- **포함되지 않는 트래픽:** 같은 네트워크 안에서 스위치로만 오간 통신은 게이트웨이를 지나지 않아 보이지 않습니다. 게이트웨이 자신의 트래픽(Tailscale, UniFi 클라우드 등)은 클라이언트에 배정하지 않습니다.
- **업로드와 다운로드:** 클라이언트가 보낸 바이트가 업로드, 받은 바이트가 다운로드입니다. 단위는 IP 패킷 크기이므로 전송한 파일 크기보다 TCP/IP 헤더만큼 큽니다.

바이트는 5분 UTC 버킷에 시간 비율로 나누어 기록합니다. 각 버킷에는 에이전트가 실제로 측정한 시간(`coverageSeconds`)이 함께 저장됩니다. 에이전트가 재시작하면 첫 조회는 기준값으로만 쓰므로, 그 버킷의 측정 시간은 300초보다 짧아집니다.

## 설치

UCG에 root로 SSH 접속한 뒤 실행합니다. UniFi OS 2 이상의 aarch64 장비와 `net.netfilter.nf_conntrack_acct=1`이 필요합니다.

```sh
curl -sSLf https://raw.githubusercontent.com/aroxu/unifi-traffic-monitr/main/agent/install.sh | sh
```

특정 버전은 `sh -s -- v0.1.0`처럼 지정합니다. 설치 스크립트는 GitHub Release의 패키지와 SHA-256 체크섬을 확인한 뒤 `/data/unifi-traffic-agent`에 풉니다. 처음 설치할 때 다음을 만듭니다.

- `agent.env`(권한 600): 수신 주소는 `br0`의 IPv4:8790이고, 무작위 토큰이 들어갑니다.
- `tls/`: 10년짜리 자체 서명 인증서입니다.

설치가 끝나면 스트림 주소와 인증서 지문이 출력됩니다. 토큰은 `/data/unifi-traffic-agent/manage.sh token`으로 확인합니다.

## 수집기 설정

수집기의 `.env`에 세 값을 함께 지정합니다. 모두 비우면 에이전트 연결을 사용하지 않습니다.

```sh
UNIFI_AGENT_URL=wss://<게이트웨이 LAN IP>:8790/v1/stream
UNIFI_AGENT_TOKEN=<manage.sh token 출력>
UNIFI_AGENT_CERT_SHA256=<manage.sh info의 Certificate 값>
```

수집기는 먼저 인증 정보 없이 TLS로 연결해 인증서 지문을 비교합니다. 일치할 때만 그 인증서를 유일한 신뢰 기준으로 삼아 토큰을 보냅니다. 에이전트는 `internet`과 `lan` 범위를 사용합니다. 에이전트를 켠 상태에서 API 카운터 매핑(`UNIFI_WIRED_SCOPE` 등)을 이 두 범위로 지정하면 수집기가 시작하지 않습니다. 기존 `reported` 매핑은 함께 쓸 수 있으며, 화면은 에이전트의 인터넷 범위를 먼저 표시합니다.

## 관리

```sh
/data/unifi-traffic-agent/manage.sh status        # 실행 여부와 health check
/data/unifi-traffic-agent/manage.sh info          # 버전, 스트림 주소, 인증서 지문
/data/unifi-traffic-agent/manage.sh token         # 수집기에 넣을 토큰
/data/unifi-traffic-agent/manage.sh rotate-token  # 토큰 교체 후 재시작
/data/unifi-traffic-agent/manage.sh update [v0.1.0]
/data/unifi-traffic-agent/manage.sh uninstall [--purge]
journalctl -u unifi-traffic-agent -f
```

`agent.env`의 설정은 다음과 같습니다. 값을 바꾼 뒤 `manage.sh restart`를 실행합니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AGENT_LISTEN` | `<br0 IPv4>:8790` | 쉼표로 구분한 IP:포트. LAN 주소만 지정합니다 |
| `AGENT_TOKEN` | 설치 시 생성 | 32자 이상 |
| `AGENT_RETENTION_DAYS` | 7 | 장비에 보관하는 5분 기록 일수(1~30) |
| `AGENT_LIVE_INTERVAL_MS` | 1000 | 수집기 연결 중 조회 주기 |
| `AGENT_IDLE_INTERVAL_MS` | 10000 | 연결이 없을 때 조회 주기 |
| `AGENT_CLIENT_INTERFACES` | `br*` | 클라이언트 네트워크 인터페이스 이름 패턴 |

## 재부팅과 펌웨어 업데이트

[tailscale-unifi](https://github.com/SierraSoftworks/tailscale-unifi)와 같은 방식으로 영구 저장소를 사용합니다.

- **`/data/unifi-traffic-agent`:** 실행 파일, 설정, 인증서, 5분 기록(`buckets/YYYY-MM-DD.jsonl`), 열린 버킷 체크포인트(`state/`)를 둡니다. 체크포인트는 60초마다 저장됩니다.
- **systemd 서비스:** `unifi-traffic-agent.service`는 심볼릭 링크가 아닌 일반 파일로 `/etc/systemd/system`에 복사합니다. `RequiresMountsFor=/data/unifi-traffic-agent`, `Restart=always`를 사용합니다.
- **부팅 훅:** `/data/on_boot.d/20-unifi-traffic-agent.sh`가 부팅 때 서비스 파일을 복구하고 에이전트를 시작합니다. 이 훅은 `udm-boot.service`가 실행합니다.
- **자원 제한:** 서비스는 `CPUQuota=50%`, `MemoryMax=128M`, `GOMEMLIMIT=64MiB`로 제한됩니다. 권한은 `CAP_NET_ADMIN`만 남기고, `/data/unifi-traffic-agent` 외에는 읽기 전용입니다.

## WebSocket 프로토콜 v1

`GET /healthz`는 인증 없이 `ok`를 반환합니다. `GET /v1/stream`은 `Authorization: Bearer <token>`이 필요합니다. 토큰이 틀리면 401을 반환하고, 같은 IP에서 1분 동안 5회 실패하면 429를 반환합니다. 동시 연결은 4개까지입니다.

1. 에이전트가 `hello {protocol, agentId, version, now, earliestBucket}`를 보냅니다.
2. 수집기가 10초 안에 `resume {since}`를 보냅니다. `since`는 DB에 저장된 마지막 확정 버킷 시작 시각이며, 처음이면 `null`입니다.
3. 에이전트가 그 뒤의 확정 버킷을 `buckets {items}`로 100개씩 보내고, 마지막에 `replay_done {through}`를 보냅니다.
4. 이후 에이전트는 매 조회마다 `live {at, intervalMs, subjects}`를 보냅니다. 값은 직전 메시지 이후의 바이트입니다.
5. 열린 버킷은 30초마다 `bucket {final: false}`로, 닫힐 때는 `bucket {final: true}`로 보냅니다.

버킷의 바이트는 64비트 정밀도를 위해 십진 문자열로 보냅니다. 수집기는 같은 버킷을 다시 받으면 이전 값을 새 값으로 바꿉니다. 이미 확정된 값을 미확정 값으로 덮어쓰지는 않습니다.

## 빌드와 배포

Go 1.26으로 빌드합니다. 로컬에 Go가 없으면 Docker를 사용할 수 있습니다.

```sh
docker run --rm --network host -v "$PWD/agent:/src" -w /src golang:1.26 bash build/build.sh v0.1.0 dist
```

`agent-v*` 태그를 푸시하면 GitHub Actions가 테스트 후 arm64·amd64 패키지와 체크섬을 Release에 올립니다. 장비에 직접 복사한 패키지는 `AGENT_PACKAGE_FILE=/tmp/unifi-traffic-agent-linux-arm64.tgz sh install.sh`로 설치합니다.
