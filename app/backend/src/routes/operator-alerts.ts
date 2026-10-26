import type {FastifyInstance} from 'fastify';
import {OperatorAlertInputError,type OperatorAlertService} from '../operations/operator-alerts.js';
import {OperatorApprovalError} from '../withdrawals/operator-approvals.js';

export async function registerOperatorAlertRoutes(app:FastifyInstance,service?:OperatorAlertService){
 app.get('/v1/admin/operational-alerts',async(request,reply)=>{
  reply.header('Cache-Control','no-store');
  if(!request.authenticatedUser)return reply.code(401).send({error:{code:'AUTH_REQUIRED'}});
  if(!service)return reply.code(503).send({error:{code:'OPERATIONAL_ALERTS_UNAVAILABLE'}});
  try{
   if(request.body!==undefined)return reply.code(400).send({error:{code:'VALIDATION_ERROR'}});
   return await service.list(request.authenticatedUser,request.query);
  }catch(error){
   if(error instanceof OperatorApprovalError)return reply.code(403).send({error:{code:error.code}});
   if(error instanceof OperatorAlertInputError)return reply.code(400).send({error:{code:'VALIDATION_ERROR'}});
   request.log.warn({event:'operational_alerts_unavailable'});
   return reply.code(503).send({error:{code:'OPERATIONAL_ALERTS_UNAVAILABLE'}});
  }
 });
}
