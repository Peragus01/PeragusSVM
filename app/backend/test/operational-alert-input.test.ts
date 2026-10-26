import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {parseAlertQuery} from '../src/operations/operator-alerts.js';
describe('operational alert input',()=>{
 it('defaults to a bounded queue',()=>expect(parseAlertQuery({})).toMatchObject({kind:'all',severity:'all',limit:20,cursor:null}));
 it.each([{customer_id:randomUUID()},{limit:'0'},{limit:'51'},{limit:'1.0'},{severity:'critical'},{kind:'anything'},{cursor:'not-json'},{cursor:'a'.repeat(513)}])('rejects selectors and malformed input %j',query=>expect(()=>parseAlertQuery(query)).toThrow());
 it('preserves microseconds and deterministic tie breakers',()=>{
  const value={priority:0,at:'2026-10-26T01:00:00.123456Z',id:randomUUID(),kind:'withdrawal_uncertain'};
  const cursor=Buffer.from(JSON.stringify(value)).toString('base64url');
  expect(parseAlertQuery({limit:'1',cursor}).cursor).toEqual(value);
  expect(()=>parseAlertQuery({cursor:cursor+'='})).toThrow();
 });
});
