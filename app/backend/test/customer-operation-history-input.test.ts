import {describe,it,expect} from "vitest";
import {parseHistoryQuery} from "../src/purchases/customer-operation-history.js";

const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url");
const cursor={created_at:"2026-10-20T12:00:00.123456Z",id:"123e4567-e89b-42d3-a456-426614174000"};
describe("operation history pagination input",()=>{
  it("bounds page size and preserves the database timestamp precision",()=>{
    expect(parseHistoryQuery({})).toEqual({limit:20,cursor:null});
    expect(parseHistoryQuery({limit:"50",cursor:encode(cursor)})).toEqual({limit:50,cursor});
  });
  it.each([{}, {...cursor,created_at:"2026-02-30T12:00:00.123456Z"},
    {...cursor,created_at:"2026-10-20T12:00:00.123Z"},
    {...cursor,id:"not-a-uuid"},{...cursor,customer_id:"foreign"}])("rejects malformed cursor evidence %j",value=>{
    expect(()=>parseHistoryQuery({cursor:encode(value)})).toThrow();
  });
  it.each(["0","-1","51","1.5","1e1","01",""])("rejects invalid limit %s",limit=>{
    expect(()=>parseHistoryQuery({limit})).toThrow();
  });
});
