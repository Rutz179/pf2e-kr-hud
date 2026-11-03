# PF2e-KR HUD 디스코드 음성 브리지

디스코드 음성 채널에서 누가 말하는지를 Foundry로 전달해, 말하는 사람의 스테이지 초상화를
채팅할 때처럼 전면으로 띄웁니다.

봇은 디스코드의 "말하기 시작/끝" **신호만** 받습니다. 누구의 목소리도 녹음하거나 해석하지
않습니다.

**설정은 게임 안에서 하는 것이 가장 쉽습니다.** 모듈 설정 → *디스코드 음성 연동 설정 도우미*가
필요한 명령과 파일을 값이 채워진 상태로 만들어 줍니다. 아래는 도우미가 하는 일을 손으로 할 때의
설명입니다.

---

## 먼저 알아둘 것: Node.js와 설치 파일

- 브리지를 돌릴 컴퓨터에 **Node.js 20 이상을 직접 설치**하세요.
  - Windows: <https://nodejs.org/ko> 에서 LTS
  - Ubuntu 서버:
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
    ```
- **`node_modules` 폴더를 다른 컴퓨터에서 복사해 오지 마세요.** 음성 암호화 라이브러리에는
  운영체제·CPU마다 다른 파일이 들어 있어서, Windows에서 설치한 것은 Linux 서버(특히 ARM인 Oracle
  무료 인스턴스)에서 동작하지 않습니다. 항상 그 컴퓨터에서 `npm install`로 새로 설치하세요.

## 설정 파일 `.env`

이 폴더(`bridge.js` 옆)에 `.env`를 만들면 브리지가 스스로 읽습니다.

```
DISCORD_TOKEN=봇토큰
GUILD_ID=서버ID
VOICE_CHANNEL_ID=음성채널ID
PORT=8787
SHARED_KEY=긴랜덤키
```

토큰이 들어 있으니 다른 사람에게 보내거나 저장소에 올리지 마세요.
도우미의 연결 확인 단계는 이 파일이 **인터넷에서 읽히지 않는지 실제로 요청해서 확인**합니다.

---

## 내 PC에서 (로컬 호스팅)

도우미에서 *내 PC*를 고르면 `start-voice-bridge.bat`을 저장할 수 있습니다. **이 폴더 안에 저장**한
뒤 더블클릭하면 Node.js 확인 → `.env` 작성 → 첫 설치 → 실행을 순서대로 합니다.

## 서버에서 (pm2 + Caddy)

SSH에서 모듈의 이 폴더로 이동한 뒤 한 줄씩:

```bash
# .env 작성 (값은 도우미가 채워 줍니다)
printf 'DISCORD_TOKEN=%s\nGUILD_ID=%s\nVOICE_CHANNEL_ID=%s\nPORT=%s\nSHARED_KEY=%s\n' '토큰' '서버ID' '채널ID' '8787' '키' > .env && chmod 600 .env

npm install --omit=dev
pm2 start bridge.js --name pf2e-kr-voice-bridge && pm2 save
pm2 logs pf2e-kr-voice-bridge --lines 20 --nostream
```

Node.js가 있으면 pm2는 `sudo npm install -g pm2`로 설치합니다.

Caddy (`/etc/caddy/Caddyfile`):

```caddy
내도메인.duckdns.org {
    handle_path /discord-voice/* {
        reverse_proxy 127.0.0.1:8787
    }

    handle {
        reverse_proxy 127.0.0.1:30000
    }
}
```

```bash
sudo systemctl reload caddy
```

Foundry의 브리지 주소: `wss://내도메인.duckdns.org/discord-voice/?key=긴랜덤키`

**모듈을 업데이트하면** 이 폴더의 `.env`와 설치 파일이 지워질 수 있습니다. 연결이 끊기면
위 단계를 다시 실행하세요.

## 처음부터 다시

- 게임 안: 도우미 아래쪽의 **처음부터 다시**
- 서버:
  ```bash
  pm2 delete pf2e-kr-voice-bridge; pm2 save; rm -f .env
  ```

## 확인 목록

| 상황 | 기대 동작 |
| --- | --- |
| A가 말함 | 모든 참가자 화면에서 A의 초상화가 켜짐 |
| A가 멈춤 | 잠시 후 꺼짐 |
| A가 10초 이상 계속 말함 | 도중에 꺼지지 않음 |
| A와 B가 동시에 말함 | 둘 다 켜짐 |
| A가 말하다가 음성방을 나감 | A가 켜진 채로 남지 않음 |
| 브리지를 껐다 켬 | Foundry가 스스로 재연결 |

## 알아둘 점

- 봇이 음성 채널에 **멤버로 보입니다.** 음소거 상태로 들어가 있습니다.
- 디스코드는 음성 암호화 방식(DAVE)을 계속 바꾸고 있습니다. 동작이 멈추면 이 폴더에서
  `npm update` 후 재시작해 보세요.
