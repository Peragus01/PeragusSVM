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
  // JWT signature is verified by the Supabase gateway (verify_jwt=true).
  // Only a service_role JWT can invoke the queue worker; user/anon JWTs are rejected.
  const auth=request.headers.get("authorization")||"";
  const jwt=auth.match(/^Bearer ([-_A-Za-z0-9.]+)$/)?.[1];
  let role="";
  try {
    if(jwt?.split(".").length===3){
      const part=jwt.split(".")[1].replace(/-/g,"+").replace(/_/g,"/");
      role=JSON.parse(atob(part)).role??"";
    }
  }catch { return json({error:"unauthorized"},401); }
  if(role!=="service_role") return json({error:"unauthorized"},401);
  const rpc=async(name:string,payload:object)=>fetch(`${url}/rest/v1/rpc/${name}`,{method:"POST",headers:{"apikey":serviceKey,"authorization":`Bearer ${serviceKey}`,"content-type":"application/json"},body:JSON.stringify(payload)});
  const claimed=await rpc("claim_welcome_email",{});
  if(!claimed.ok) return json({error:"claim_failed",upstream_status:claimed.status,upstream_code:(await claimed.json().catch(()=>({}))).code??"unknown"},502);
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
