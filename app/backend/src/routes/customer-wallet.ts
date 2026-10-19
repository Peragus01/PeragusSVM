import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {WalletProofError,type CustomerWalletService} from "../wallets/customer-wallet.js";
export async function registerCustomerWalletRoutes(app:FastifyInstance,service?:CustomerWalletService){
  await app.register(async scoped=>{
    scoped.removeContentTypeParser("application/json");
    scoped.addContentTypeParser("application/json",{parseAs:"buffer",bodyLimit:4096},(_req,body,done)=>done(null,body));
    for(const action of ["read","challenge","confirm"] as const)scoped.route({
      method:action==="read"?"GET":"POST",url:`/v1/me/wallet${action==="read"?"":`/${action}`}`,bodyLimit:4096,
      handler:async(request,reply)=>{
        reply.header("Cache-Control","no-store");
        if(!request.authenticatedUser)return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
        if(!service)return reply.code(503).send({error:{code:"CUSTOMER_WALLET_LINKING_DISABLED"}});
        const customer=request.authenticatedCustomer;
        if(!customer || customer.type!=="pf" || customer.suspended)return reply.code(403).send({error:{code:"INDIVIDUAL_PROFILE_REQUIRED"}});
        if(Object.keys(request.query as object).length)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
        try {
          if(action==="read")return {data:await service.read(customer.id)};
          let body:unknown;
          try{body=JSON.parse((request.body as Buffer).toString("utf8"));}catch{return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});}
          if(action==="challenge"){
            const parsed=z.object({wallet_address:z.string().min(32).max(44)}).strict().safeParse(body);
            if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
            return reply.code(201).send({data:await service.start(customer.id,parsed.data.wallet_address)});
          }
          const parsed=z.object({challenge_id:z.string().uuid(),signature_base64:z.string().length(88)}).strict().safeParse(body);
          if(!parsed.success)return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
          return {data:await service.confirm(customer.id,parsed.data.challenge_id,parsed.data.signature_base64)};
        }catch(error){
          if(error instanceof WalletProofError)return reply.code(error.code==="WALLET_ADDRESS_INVALID"?400:error.code==="WALLET_SIGNATURE_INVALID"?403:409).send({error:{code:error.code}});
          request.log.warn({event:"customer_wallet_linking_unavailable"});return reply.code(503).send({error:{code:"CUSTOMER_WALLET_LINKING_UNAVAILABLE"}});
        }
      }
    });
  });
}
