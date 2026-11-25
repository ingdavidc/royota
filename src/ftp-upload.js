'use strict';

const net = require('net');
const config = require('./config');
const { getMatchingLocalIp } = require('./utils/helpers');

/**
 * Carga por FTP solo bajo demanda usando variables de entorno (nunca credenciales fijas).
 */
function ftpUpload(remotePath, content) {
  const host = config.mikrotik.host;
  const user = config.mikrotik.user;
  const pass = config.mikrotik.pass;
  if (!user || !pass) {
    return Promise.reject(new Error('Faltan MIKROTIK_USER / MIKROTIK_PASS en variables de entorno.'));
  }

  const localAddress = getMatchingLocalIp(host);

  return new Promise((resolve, reject) => {
    const control = net.createConnection({
      host,
      port: 21,
      ...(localAddress ? { localAddress } : {}),
    });

    let state = 'INIT';

    function send(cmd) {
      control.write(cmd + '\r\n');
    }

    control.on('data', (data) => {
      const msg = data.toString();

      if (state === 'INIT' && msg.startsWith('220')) {
        state = 'USER';
        send(`USER ${user}`);
      } else if (state === 'USER' && msg.startsWith('331')) {
        state = 'PASS';
        send(`PASS ${pass}`);
      } else if (state === 'PASS' && msg.startsWith('230')) {
        state = 'TYPE';
        send('TYPE I');
      } else if (state === 'TYPE' && msg.startsWith('200')) {
        state = 'PASV';
        send('PASV');
      } else if (state === 'PASV' && msg.startsWith('227')) {
        const match = msg.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
        if (!match) {
          control.end();
          return reject(new Error('Invalid PASV response: ' + msg));
        }
        const dataPort = parseInt(match[5], 10) * 256 + parseInt(match[6], 10);
        const dataSocket = net.createConnection({
          host,
          port: dataPort,
          ...(localAddress ? { localAddress } : {}),
        }, () => {
          state = 'STOR';
          send('STOR ' + remotePath);
        });

        dataSocket.on('error', (err) => {
          control.end();
          reject(err);
        });

        control.once('data', (storMsg) => {
          if (storMsg.toString().startsWith('150')) {
            dataSocket.write(content, () => {
              dataSocket.end();
            });
          }
        });

        dataSocket.on('close', () => {
          control.once('data', (finishMsg) => {
            send('QUIT');
            control.end();
            resolve(finishMsg.toString().trim());
          });
        });
      }
    });

    control.on('error', reject);
  });
}

module.exports = { ftpUpload };
