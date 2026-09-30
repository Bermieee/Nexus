const clone=(v)=>structuredClone(v);
const req=(v,n)=>{if(typeof v!=='string'||!v.length)throw new TypeError(`${n} must be a non-empty string`);return v;};
export const StructuredValidationStage=Object.freeze({PARSE:'PARSE',TYPE:'TYPE',SEMANTIC:'SEMANTIC',NORMALIZE:'NORMALIZE',COMPLETE:'COMPLETE'});
export const StructuredValidationCode=Object.freeze({PARSE_FAILED:'STRUCTURED_PARSE_FAILED',SCHEMA_UNKNOWN:'STRUCTURED_SCHEMA_UNKNOWN',SCHEMA_VERSION_UNSUPPORTED:'STRUCTURED_SCHEMA_VERSION_UNSUPPORTED',TYPE_FAILED:'STRUCTURED_TYPE_VALIDATION_FAILED',SEMANTIC_FAILED:'STRUCTURED_SEMANTIC_VALIDATION_FAILED',NORMALIZATION_FAILED:'STRUCTURED_NORMALIZATION_FAILED'});

function outcome(result,defaults={}){if(result===true||result===undefined)return{ok:true,errors:[]};if(result===false)return{ok:false,errors:['validation returned false']};if(result&&typeof result==='object')return{ok:Boolean(result.ok),errors:[...(result.errors??(result.reason?[result.reason]:[]))]};return{ok:false,errors:[String(result)]};}
function failure({code,stage,schemaId,schemaVersion,providerId,errors=[],retryable=true,fallbackEligible=true}){return{kind:'StructuredValidationFailure',code,stage,failureStage:stage,schemaId,schemaVersion,providerId,errors:[...errors].map(String),retryable:Boolean(retryable),fallbackEligible:Boolean(fallbackEligible),canonicalReady:false};}

export class StructuredOutputSchemaRegistry{
  #schemas=new Map();
  register({schemaId,schemaVersion='1.0.0',typeValidate,semanticValidate=()=>({ok:true}),normalize=(x)=>x}={}){
    req(schemaId,'schemaId');req(schemaVersion,'schemaVersion');if(typeof typeValidate!=='function'||typeof semanticValidate!=='function'||typeof normalize!=='function')throw new TypeError('schema requires typeValidate, semanticValidate, and normalize functions');
    const key=`${schemaId}@${schemaVersion}`;if(this.#schemas.has(key))throw new Error(`STRUCTURED_SCHEMA_DUPLICATE:${key}`);this.#schemas.set(key,{schemaId,schemaVersion,typeValidate,semanticValidate,normalize});return this.inspect(schemaId,schemaVersion);
  }
  inspect(schemaId,schemaVersion){const x=this.#schemas.get(`${schemaId}@${schemaVersion}`);return x?{schemaId:x.schemaId,schemaVersion:x.schemaVersion}:null;}
  versions(schemaId){return[...this.#schemas.values()].filter(x=>x.schemaId===schemaId).map(x=>x.schemaVersion).sort();}
  get(schemaId,schemaVersion){return this.#schemas.get(`${schemaId}@${schemaVersion}`)??null;}
}

export class CoreStructuredOutputValidator{
  constructor({registry=new StructuredOutputSchemaRegistry()}={}){this.registry=registry;}
  validate({schemaId,schemaVersion='1.0.0',rawOutput,providerId='provider-neutral'}={}){
    req(schemaId,'schemaId');req(schemaVersion,'schemaVersion');let parsed;
    try{parsed=typeof rawOutput==='string'?JSON.parse(rawOutput):clone(rawOutput);}catch(error){return{ok:false,canonicalReady:false,stage:StructuredValidationStage.PARSE,failure:failure({code:StructuredValidationCode.PARSE_FAILED,stage:StructuredValidationStage.PARSE,schemaId,schemaVersion,providerId,errors:[error?.message??String(error)]}),normalized:null};}
    const versions=this.registry.versions(schemaId);if(!versions.length)return{ok:false,canonicalReady:false,stage:StructuredValidationStage.TYPE,failure:failure({code:StructuredValidationCode.SCHEMA_UNKNOWN,stage:StructuredValidationStage.TYPE,schemaId,schemaVersion,providerId,retryable:false}),normalized:null};
    const schema=this.registry.get(schemaId,schemaVersion);if(!schema)return{ok:false,canonicalReady:false,stage:StructuredValidationStage.TYPE,failure:failure({code:StructuredValidationCode.SCHEMA_VERSION_UNSUPPORTED,stage:StructuredValidationStage.TYPE,schemaId,schemaVersion,providerId,errors:[`supported: ${versions.join(',')}`],fallbackEligible:false}),normalized:null};
    let typed;try{typed=outcome(schema.typeValidate(clone(parsed)));}catch(error){typed={ok:false,errors:[error?.message??String(error)]};}
    if(!typed.ok)return{ok:false,canonicalReady:false,stage:StructuredValidationStage.TYPE,failure:failure({code:StructuredValidationCode.TYPE_FAILED,stage:StructuredValidationStage.TYPE,schemaId,schemaVersion,providerId,errors:typed.errors}),normalized:null};
    let semantic;try{semantic=outcome(schema.semanticValidate(clone(parsed)));}catch(error){semantic={ok:false,errors:[error?.message??String(error)]};}
    if(!semantic.ok)return{ok:false,canonicalReady:false,stage:StructuredValidationStage.SEMANTIC,failure:failure({code:StructuredValidationCode.SEMANTIC_FAILED,stage:StructuredValidationStage.SEMANTIC,schemaId,schemaVersion,providerId,errors:semantic.errors}),normalized:null};
    let normalized;try{normalized=schema.normalize(clone(parsed));JSON.stringify(normalized);}catch(error){return{ok:false,canonicalReady:false,stage:StructuredValidationStage.NORMALIZE,failure:failure({code:StructuredValidationCode.NORMALIZATION_FAILED,stage:StructuredValidationStage.NORMALIZE,schemaId,schemaVersion,providerId,errors:[error?.message??String(error)]}),normalized:null};}
    return{ok:true,stage:StructuredValidationStage.COMPLETE,failureStage:null,failure:null,retryable:false,fallbackEligible:false,canonicalReady:true,schemaId,schemaVersion,providerId,normalized:clone(normalized)};
  }
}
