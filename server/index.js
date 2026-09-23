import express from 'express';
import cors from 'cors';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const dbFile = join(dir, 'data.json');
const seed = { business:{id:'biz_pulse',name:'Pulse Fitness',type:'Gym & fitness studio',phone:'+91 98765 43210',email:'hello@pulsefitness.in',address:'Andheri West, Mumbai',timezone:'Asia/Kolkata'}, members:[{id:'mem_1',name:'Aarav Mehta',phone:'+919800000001',plan:'Premium',expiresAt:'2026-12-12',status:'active'},{id:'mem_2',name:'Sara Khan',phone:'+919800000002',plan:'Monthly',expiresAt:'2026-09-25',status:'expiring'},{id:'mem_3',name:'Rohan Desai',phone:'+919800000003',plan:'Quarterly',expiresAt:'2026-11-14',status:'active'}], automations:[{id:'welcome',name:'Welcome new members',event:'member.created',enabled:true,delay:'Immediately',message:'Welcome to Pulse, {first_name}! We’re excited to have you.'},{id:'expiry',name:'Membership expiration',event:'membership.expiring',enabled:true,delay:'7 days before expiry',message:'Hi {first_name}, your membership ends soon. Renew now to continue your progress.'},{id:'payment',name:'Payment due reminder',event:'payment.overdue',enabled:true,delay:'3 days after payment due',message:'Hi {first_name}, your payment is still due.'}], notifications:[] };
function load(){if(!existsSync(dbFile)){mkdirSync(dir,{recursive:true});writeFileSync(dbFile,JSON.stringify(seed,null,2));return structuredClone(seed)}return JSON.parse(readFileSync(dbFile))}
function save(data){writeFileSync(dbFile,JSON.stringify(data,null,2))}
function personalize(text, member){return text.replaceAll('{first_name}',member.name.split(' ')[0])}
function dispatch(data,{memberIds,message,kind='manual',automationId=null}){const recipients=data.members.filter(m=>memberIds==='all'||memberIds.includes(m.id));const record={id:`ntf_${Date.now()}`,kind,automationId,message,recipients:recipients.map(m=>({memberId:m.id,name:m.name,body:personalize(message,m),channel:'whatsapp',status:'queued'})),createdAt:new Date().toISOString()};data.notifications.unshift(record);return record}
function runAutomaticRules(){const data=load(), today=new Date().toISOString().slice(0,10);data.executions??={};const rule=data.automations.find(a=>a.event==='membership.expiring'&&a.enabled);if(!rule||data.executions[`${rule.id}:${today}`])return 0;const recipients=data.members.filter(m=>m.status==='expiring');if(!recipients.length)return 0;dispatch(data,{memberIds:recipients.map(m=>m.id),message:rule.message,kind:'automatic',automationId:rule.id});data.executions[`${rule.id}:${today}`]=new Date().toISOString();save(data);return recipients.length}
const app=express(); app.use(cors()); app.use(express.json());
app.get('/api/health',(_,res)=>res.json({ok:true}));
app.get('/api/business',(_,res)=>res.json(load().business));
app.patch('/api/business',(req,res)=>{const data=load();data.business={...data.business,...req.body};save(data);res.json(data.business)});
app.get('/api/members',(req,res)=>{const q=(req.query.q||'').toLowerCase();res.json(load().members.filter(m=>m.name.toLowerCase().includes(q)))});
app.post('/api/members',(req,res)=>{const data=load();const member={id:`mem_${Date.now()}`,status:'active',...req.body};data.members.unshift(member);const rule=data.automations.find(a=>a.event==='member.created'&&a.enabled);if(rule)dispatch(data,{memberIds:[member.id],message:rule.message,kind:'automatic',automationId:rule.id});save(data);res.status(201).json(member)});
app.get('/api/automations',(_,res)=>res.json(load().automations));
app.patch('/api/automations/:id',(req,res)=>{const data=load();const rule=data.automations.find(a=>a.id===req.params.id);if(!rule)return res.sendStatus(404);Object.assign(rule,req.body);save(data);res.json(rule)});
app.post('/api/notifications',(req,res)=>{const data=load();const notification=dispatch(data,{memberIds:req.body.memberIds||'all',message:req.body.message,kind:'manual'});save(data);res.status(201).json(notification)});
app.get('/api/notifications',(_,res)=>res.json(load().notifications));
app.post('/api/automations/run',(_,res)=>res.json({sent:runAutomaticRules()}));
setInterval(runAutomaticRules,60*60*1000); // production scheduler: checks expiry rules hourly; each rule runs once per day
app.listen(4000,()=>console.log('Pulse API running at http://localhost:4000'));
