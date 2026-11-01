// Staging-only queue worker. Deploy only after configuring RESEND_API_KEY and RESEND_FROM.
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (managed server-side).
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
Deno.serve(async (request)=>{
  if(request.method!=="POST") return json({error:"method_not_allowed"},405);
  const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const url=Deno.env.get("SUPABASE_URL");
  const resendKey=Deno.env.get("RESEND_API_KEY");
  const from=Deno.env.get("RESEND_FROM");
  if(!serviceKey||!url||!resendKey||!from) return json({error:"not_configured"},503);
  if(request.headers.get("authorization")!==`Bearer ${serviceKey}`) return json({error:"unauthorized"},401);
  const rpc=async(name:string,payload:object)=>fetch(`${url}/rest/v1/rpc/${name}`,{method:"POST",headers:{"apikey":serviceKey,"authorization":`Bearer ${serviceKey}`,"content-type":"application/json"},body:JSON.stringify(payload)});
  const claimed=await rpc("claim_welcome_email",{});
  if(!claimed.ok) return json({error:"claim_failed"},502);
  const rows=await claimed.json() as {user_id:string;recipient_email:string;first_name:string|null}[];
  if(!rows.length) return json({processed:0});
  const record=rows[0];
  // One deterministic idempotency key per confirmed user; retries won't create another Resend send.
  const send=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":`Bearer ${resendKey}`,"Content-Type":"application/json","Idempotency-Key":`peragus-welcome-${record.user_id}`},body:JSON.stringify({from,to:[record.recipient_email],template:{id:"peragus-boas-vindas",variables:{FIRST_NAME:record.first_name||"cliente"}}})});
  const result=await send.json().catch(()=>({})) as {id?:string;message?:string};
  const finished=await rpc("finish_welcome_email",{p_user_id:record.user_id,p_success:send.ok,p_provider_id:result.id||null,p_error:send.ok?null:(result.message||`HTTP ${send.status}`)});
  if(!finished.ok)return json({error:"finalize_failed"},502);
  return json({processed:1,sent:send.ok});
});