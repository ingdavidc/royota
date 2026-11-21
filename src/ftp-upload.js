const net = require('net');
const fs = require('fs');
const path = require('path');

function ftpUpload(remotePath, content) {
  return new Promise((resolve, reject) => {
    const control = net.createConnection({
      host: '192.168.10.1',
      port: 21,
      localAddress: '192.168.10.100'
    });

    let buffer = '';
    let state = 'INIT';

    function send(cmd) {
      // console.log('> ' + cmd);
      control.write(cmd + '\r\n');
    }

    control.on('data', data => {
      const msg = data.toString();
      // console.log('< ' + msg.trim());

      if (state === 'INIT' && msg.startsWith('220')) {
        state = 'USER';
        send('USER api-fichas');
      } else if (state === 'USER' && msg.startsWith('331')) {
        state = 'PASS';
        send('PASS RoyotaWifi2026*');
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
          host: '192.168.10.1',
          port: dataPort,
          localAddress: '192.168.10.100'
        }, () => {
          state = 'STOR';
          send('STOR ' + remotePath);
        });

        dataSocket.on('error', err => {
          control.end();
          reject(err);
        });

        control.once('data', storMsg => {
          // Expect 150
          if (storMsg.toString().startsWith('150')) {
            dataSocket.write(content, () => {
              dataSocket.end();
            });
          }
        });

        dataSocket.on('close', () => {
          control.once('data', finishMsg => {
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
