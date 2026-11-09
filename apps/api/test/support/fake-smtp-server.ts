import net from 'node:net';

/** 서버가 받은 메일 한 통(SMTP 대화에서 실제로 오간 값) */
export interface ReceivedMail {
  mailFrom: string;
  /** `RCPT TO:<...>` 로 받은 수신자들. 실제 봉투(envelope)의 수신자 수를 그대로 보여 준다 */
  rcptTo: string[];
  data: string;
}

export type ServerMode =
  /** 정상: 메일을 받고 250으로 응답한다 */
  | 'accept'
  /** 연결은 받지만 인사(220)조차 보내지 않는다 */
  | 'silent'
  /** 인사는 하지만 DATA 이후 마지막 응답을 보내지 않는다(메일 본문까지 받아 놓고 끝을 알리지 않는다) */
  | 'hang-after-data'
  /** STARTTLS를 광고하고 `220 ready`까지 답한 뒤 TLS 협상에 응하지 않는다(암호화로 올라가는 도중에 멈춘다) */
  | 'hang-at-starttls';

/**
 * 실제 SMTP 프로토콜(EHLO · MAIL · RCPT · DATA · QUIT)을 말하는 가짜 서버. 평문이다(암호화를 광고하지 않는다).
 * 서비스 코드는 STARTTLS를 요구하므로 이 서버에는 직접 붙지 않고, 라이브러리 설정만 평문용으로 바꾼 전송 수단으로 붙는다.
 * 테스트가 확인하는 것: 실제 봉투의 수신자 수, 시간 초과 때 연결이 끊기는지, 동시에 열린 연결의 수.
 */
export async function startFakeSmtpServer(mode: ServerMode = 'accept') {
  const mails: ReceivedMail[] = [];
  const sockets = new Set<net.Socket>();
  const modes = new Map<net.Socket, ServerMode>();
  let nextMode: ServerMode = mode;
  let connections = 0;

  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    modes.set(socket, nextMode);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);

    const thisMode = modes.get(socket)!;
    if (thisMode === 'silent') {
      // 아무 말도 하지 않는다. 다만 받은 데이터는 읽어서 버린다: 읽지 않으면 스트림이 멈춰 있어
      // 클라이언트가 연결을 끊어도(FIN) 서버가 그 신호를 처리하지 못하고 계속 열린 것으로 남는다(실제 서버는 읽는다)
      socket.resume();
      return;
    }

    socket.write('220 fake-smtp ready\r\n');

    let current: ReceivedMail = { mailFrom: '', rcptTo: [], data: '' };
    let inData = false;
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          mails.push(current);
          if (thisMode === 'hang-after-data') return; // 마지막 250을 보내지 않는다
          current = { mailFrom: '', rcptTo: [], data: '' };
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write(
            thisMode === 'hang-at-starttls'
              ? '250-fake-smtp\r\n250-STARTTLS\r\n250 8BITMIME\r\n'
              : '250-fake-smtp\r\n250 8BITMIME\r\n',
          );
        } else if (upper === 'STARTTLS' && thisMode === 'hang-at-starttls') {
          socket.write('220 ready to start TLS\r\n');
          // 이후 클라이언트가 보내는 TLS 핸드셰이크에는 응하지 않는다
          socket.removeAllListeners('data');
          return;
        } else if (upper.startsWith('MAIL FROM')) {
          current.mailFrom =
            line
              .slice(line.indexOf(':') + 1)
              .replace(/[<>\s]/g, '')
              .split(' ')[0] ?? '';
          socket.write('250 ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          current.rcptTo.push(
            line
              .slice(line.indexOf(':') + 1)
              .replace(/[<>]/g, '')
              .trim()
              .split(' ')[0] ?? '',
          );
          socket.write('250 ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
          return;
        } else if (upper === 'RSET' || upper === 'NOOP') {
          socket.write('250 ok\r\n');
        } else {
          socket.write('502 not implemented\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    mails,
    /** 지금 열려 있는 연결의 수 */
    openConnections: () => sockets.size,
    /** 지금까지 받은 연결의 총 수 */
    totalConnections: () => connections,
    /** 이후에 들어오는 연결의 동작을 바꾼다 */
    setMode(next: ServerMode) {
      nextMode = next;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
