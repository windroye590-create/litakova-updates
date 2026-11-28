// The live Node driver bypasses the EXE relay. Keep its client-facing failures
// identical to native/main.c; native_http.py executes that C code to check parity.
// Raw HTTP status/category remain in requests.jsonl for diagnosis.
export function googleRelayFailure(status){
 if(status===429)return {ok:false,code:'HTTP_429',error:'Сервер зайнятий. Повторимо відправлення автоматично.'};
 if(status===401||status===403)return {ok:false,code:'HTTP_AUTH',error:'Google обмежив доступ до сервера. Перевірте чинне розгортання.'};
 if(status>=500)return {ok:false,code:'HTTP_500',error:'Сервер тимчасово недоступний. Результат залишиться у черзі.'};
 return {ok:false,code:'NETWORK',error:'Не вдалося зв’язатися із сервером. Перевірте інтернет; збережені дані доступні.'};
}
