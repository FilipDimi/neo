/**
 * Who answers on a port of this machine: nobody, an engine of ours, or some other program.
 * Asked before an engine starts, so that a second start says "it is already running" and does
 * nothing, instead of opening the company's database and then failing on the port.
 */
import http from 'node:http';

export function whoAnswers(port: number, timeoutMs = 1500): Promise<'nobody' | 'engine' | 'other'> {
  return new Promise((resolve) => {
    // A connection of its own each time: one kept from an earlier question could be dead, and that would read as an answer.
    const request = http.get({ host: '127.0.0.1', port, path: '/', agent: false, timeout: timeoutMs }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        if (text.length > 200_000) response.destroy();
      });
      // Every page an engine serves, built or plain, carries this tag.
      response.on('close', () => resolve(text.includes('<meta name="vs-token"') ? 'engine' : 'other'));
    });
    // Something holds the port and says nothing: starting there would fail all the same.
    request.on('timeout', () => {
      resolve('other');
      request.destroy();
    });
    // Refused means the port is free. Any other failure means something is there.
    request.on('error', (failure: NodeJS.ErrnoException) => resolve(failure.code === 'ECONNREFUSED' ? 'nobody' : 'other'));
  });
}
