import { expect, test } from 'bun:test';
import { Duplex } from 'node:stream';
import { ImapFlow } from 'imapflow';
import { YahooImap } from '../src/imap';
import { config } from '../src/config';

test('real ImapFlow protocol against in-memory server uses EXAMINE, UID and BODY.PEEK only', async () => {
  const bytes=Buffer.from('Date: Sun, 01 Sep 2024 10:00:00 +0100\r\nSubject: synthetic\r\n\r\nExact bytes\r\n');
  const commands:string[]=[];
  const since=new Date('2024-09-01T00:00:00.000Z');
  let metadataDate='02-Sep-2024 11:00:00 +0100';
  let input='';
  const stream=Object.assign(new Duplex({read(){},write(chunk,_encoding,done){
    input+=chunk.toString();
    while(input.includes('\r\n')) {
      const end=input.indexOf('\r\n'), line=input.slice(0,end); input=input.slice(end+2);
      commands.push(line);
      const [tag]=line.split(' ');
      const reply=(s:string|Buffer)=>this.push(s);
      if (/ CAPABILITY/.test(line)) reply('* CAPABILITY IMAP4rev1\r\n');
      else if (line.includes('LIST "" ""')) reply('* LIST (\\Noselect) "/" ""\r\n');
      else if (/ LIST /.test(line)) reply('* LIST (\\Inbox) "/" "INBOX"\r\n* LIST (\\Sent) "/" "Sent"\r\n* LIST (\\Noselect) "/" "Parent"\r\n');
      else if (/ LSUB /.test(line)) reply('* LSUB () "/" "INBOX"\r\n');
      else if (/ EXAMINE /.test(line)) {
        reply('* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 12345] valid\r\n* OK [UIDNEXT 43] next\r\n');
        reply(`${tag} OK [READ-ONLY] examined\r\n`); continue;
      } else if (/ UID SEARCH /.test(line)) reply('* SEARCH 42\r\n');
      else if (/ UID FETCH /.test(line)) {
        if (line.includes('BODY.PEEK[]')) {
          reply(`* 1 FETCH (UID 42 INTERNALDATE "02-Sep-2024 11:00:00 +0100" BODY[] {${bytes.length}}\r\n`);
          reply(bytes); reply(')\r\n');
        } else reply(`* 1 FETCH (UID 42 RFC822.SIZE ${bytes.length} INTERNALDATE "${metadataDate}")\r\n`);
      } else if (!/ LOGIN /.test(line)) { done(new Error(`Unexpected mock command: ${line}`)); return; }
      reply(`${tag} OK complete\r\n`);
    }
    done();
  }}),{setTimeout(){ return this; }});
  const client=new YahooImap(config({YAHOO_USER:'synthetic',YAHOO_APP_PASSWORD:'mock',REQUEST_INTERVAL_MS:'0'}), options => {
    expect(options.secure).toBe(true); expect(options.tls?.rejectUnauthorized).toBe(true); expect(options.logger).toBe(false);
    return new ImapFlow({...options,transport:{connect(tls,onConnect){
      expect(tls.secure).toBe(true);
      queueMicrotask(()=> { onConnect(); stream.push('* OK fake IMAP server\r\n'); }); return stream;
    }}});
  });
  try {
    await client.connect(); expect((await client.folders()).map(f=>f.path)).toEqual(['INBOX','Sent']);
    expect(await client.select('INBOX')).toBe('12345'); expect(await client.uids(since)).toEqual([42]);
    expect(commands.some(s=>/UID SEARCH SINCE 01-Sep-2024/.test(s))).toBe(true);
    expect(commands.some(s=>/UID SEARCH ALL/.test(s))).toBe(false);
    metadataDate='01-Sep-2024 00:30:00 +0100';
    expect(await client.fetch(42,1024,since)).toEqual({excluded:true});
    expect(commands.some(s=>s.includes('BODY.PEEK[]'))).toBe(false);
    metadataDate='invalid';
    await expect(client.fetch(42,1024,since)).rejects.toThrow('INVALID_INTERNALDATE');
    expect(commands.some(s=>s.includes('BODY.PEEK[]'))).toBe(false);
    metadataDate='02-Sep-2024 11:00:00 +0100';
    await expect(client.fetch(42,1,since)).rejects.toThrow('MESSAGE_SIZE_LIMIT');
    expect(commands.some(s=>s.includes('BODY.PEEK[]'))).toBe(false);
    const result=await client.fetch(42,1024,since);
    if (!result || 'excluded' in result) throw new Error('Expected source retrieval');
    expect(result.source).toEqual(bytes);
    expect(result.internalDate).toBe('2024-09-02T10:00:00.000Z');
    expect(commands.some(s=>s.includes('BODY.PEEK[]'))).toBe(true);
    expect(commands.some(s=>/\b(SELECT|STORE|MOVE|COPY|APPEND|EXPUNGE|CLOSE|DELETE)\b/.test(s))).toBe(false);
  } finally { await client.close(); }
},10000);
