const { SerialPort } = require('serialport');

const port = new SerialPort({ path: 'COM3', baudRate: 9600 });

port.on('open', () => {
  console.log('COM3 opened');

  // Modbus RTU 请求：从站1，功能码03，起始地址0，读2个寄存器
  const request = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x02, 0xC4, 0xE9]);
  console.log('Sending:', request.toString('hex'));
  port.write(request);

  setTimeout(() => {
    console.log('No response (timeout)');
    port.close();
    process.exit(0);
  }, 3000);
});

port.on('data', (data) => {
  console.log('Received:', data.toString('hex'));
  console.log('Length:', data.length, 'bytes');
  if (data.length >= 7) {
    const vals = [];
    for (let i = 0; i < data[2]; i += 2) {
      vals.push((data[3 + i] << 8) | data[4 + i]);
    }
    console.log('Temperature:', vals[0] / 10, '℃');
    console.log('Humidity:', vals[1] / 10, '%');
  }
  port.close();
  process.exit(0);
});

port.on('error', (err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
