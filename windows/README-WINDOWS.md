# RecapAI — Windows PowerShell လမ်းညွှန် (အလွယ်ဆုံးနည်း)

## 0. တစ်ကြိမ်သာ ပြင်ဆင်ရန်
PowerShell ကို **Run as Administrator** နဲ့ဖွင့်ပြီး:
```powershell
winget install --id Git.Git -e
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force
```
(Windows 10/11 မှာ `ssh` / `scp` ပါပြီးသားပါ။ မရှိရင်: `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0`)

PowerShell ကို ပိတ်ပြီး ပြန်ဖွင့်ပါ။

## 1. Code ကို ကွန်ပျူတာထဲ ဆွဲချ
```powershell
cd $HOME\Desktop
git clone https://github.com/Rimurutempest187/myrecap.git
cd myrecap
```

## ⭐ Option A — ကိုယ့် Windows PC ကနေ https://myrecap.pinlonmail.com ဖွင့်ခြင်း (VPS မလို)

Cloudflare Tunnel သုံးလို့ router port-forward၊ static IP မလိုပါ။ PC ဖွင့်ထားပြီး Docker Desktop run နေသရွေ့ website အလုပ်လုပ်ပါတယ်။

**A1. Docker Desktop ထည့်ပါ** (တစ်ကြိမ်သာ၊ Administrator PowerShell):
```powershell
winget install --id Docker.DockerDesktop -e
```
PC restart → Docker Desktop ဖွင့် → "Engine running" (အစိမ်း) ဖြစ်တဲ့ထိ စောင့်ပါ။
Settings → General → "Start Docker Desktop when you sign in" ကို အမှန်ခြစ်ထားပါ။
(RAM 8GB+ အကြံပြု။ Settings → Resources မှာ Memory 4GB+ ပေးပါ။)

**A2. Cloudflare API Token ဖန်တီးပါ** — https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token:

| Type | Permission | Access |
|---|---|---|
| Account | Cloudflare Tunnel | Edit |
| Zone | DNS | Edit |
| Zone | Zone | Read |

Zone Resources → Include → Specific zone → `pinlonmail.com` → Create → token ကို copy ထားပါ။

**A3. Run ပါ** (`myrecap` folder ထဲက PowerShell):
```powershell
.\windows\run-tunnel.ps1
```
ပထမဆုံးအကြိမ် token တောင်းပါမယ် (paste လုပ်ပြီး Enter)။ Script က tunnel ဆောက်၊ DNS ချိတ်၊ secrets ထုတ်၊ build လုပ်ပြီး အားလုံး start ပေးပါတယ် (ပထမ build ~10-20 မိနစ်)။
ပြီးရင် https://myrecap.pinlonmail.com ဖွင့်ပြီး admin email/password (script ပြတဲ့အတိုင်း) နဲ့ login → **Admin → AI Models** မှာ Gemini API key ထည့် → "Recommended" နှိပ်ပါ။

> ⚠️ `myrecap.pinlonmail.com` အတွက် Cloudflare DNS မှာ A record (VPS IP) ရှိပြီးသားဆိုရင် script က tunnel CNAME နဲ့ အစားထိုးပါမယ်။

**နေ့စဉ်သုံး command များ:**
```powershell
.\windows\run-tunnel.ps1            # start (PC restart ပြီးတိုင်း)
.\windows\run-tunnel.ps1 -Status    # အခြေအနေ
.\windows\run-tunnel.ps1 -Logs      # log ကြည့်
.\windows\run-tunnel.ps1 -Update    # GitHub က code အသစ် ဆွဲပြီး rebuild
.\windows\run-tunnel.ps1 -Backup    # database backup (backups\ folder)
.\windows\run-tunnel.ps1 -Stop      # ရပ်
.\windows\run-tunnel.ps1 -Quick     # domain မသုံးဘဲ ယာယီ https://xxxx.trycloudflare.com
.\windows\run-tunnel.ps1 -ResetToken # Cloudflare token အသစ်ထည့်
```

**Option A ပြဿနာများ:**
- `Docker is not running` → Docker Desktop ဖွင့်ပြီး အစိမ်းဖြစ်တဲ့ထိ စောင့်ပါ။
- Cloudflare `403 / Authentication error` → token permission ၃ ခု ပြန်စစ်ပြီး `-ResetToken`။
- Site `Error 1033` → cloudflared မ run သေး: `-Status` / `-Logs` စစ်ပါ။
- Job progress live မပြရင်လည်း app က polling နဲ့ အလိုအလျောက် update လုပ်ပါတယ်။

---

## 2. VPS ပေါ် တင်ခြင်း (command တစ်ကြောင်း)
Cloudflare DNS (`myrecap` → `169.58.6.42`, Proxied 🟠) နဲ့ SSL **Full (strict)** ပြင်ပြီးမှ:
```powershell
.\windows\deploy-vps.ps1 -Email သင့်email@gmail.com
```
- ပထမအကြိမ်: Cloudflare **Origin Certificate** ကို Notepad ထဲ paste လုပ်ခိုင်းပါမယ် (`windows\certs\origin.pem`, `origin.key`) → server password တောင်းရင် ရိုက်ထည့်ပါ → အလိုအလျောက် install လုပ်ပါမယ် (၅–၁၅ မိနစ်)။
- ပြီးရင် admin email/password ပြပေးပါမယ် → https://myrecap.pinlonmail.com

## 3. နောက်ပိုင်း Update လုပ်ခြင်း
```powershell
.\windows\push-to-github.ps1 "ဘာပြင်လဲ ရေးပါ" -Deploy
```
GitHub သို့ push → VPS ပေါ် အလိုအလျောက် update (database backup အရင်ယူပါတယ်)။

## 4. အသုံးဝင်တဲ့ command များ
| လုပ်ချင်တာ | Command |
|---|---|
| Server status | `.\windows\deploy-vps.ps1 -Status` |
| Log ကြည့်ရန် | `.\windows\deploy-vps.ps1 -Logs` (ရပ်ရန် Ctrl+C) |
| Update ပဲ လုပ်ရန် | `.\windows\deploy-vps.ps1` |
| ကိုယ့်စက်ပေါ် စမ်းရန် (Docker Desktop လို) | `.\windows\run-local.ps1` → http://localhost:8080 |
| ကိုယ့်စက်ပေါ် ရပ်ရန် | `.\windows\run-local.ps1 -Stop` |

## ပြဿနာ ဖြေရှင်းခြင်း
| Error | ဖြေရှင်းနည်း |
|---|---|
| `running scripts is disabled` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force` |
| `ssh: connect ... timed out` | VPS IP/port မှန်လား၊ provider firewall မှာ port 22 ဖွင့်ထားလား |
| `Permission denied (publickey,password)` | root password မှန်လား (`-User ubuntu` စသဖြင့် user ပြောင်းနိုင်) |
| Cloudflare 521 | `.\windows\deploy-vps.ps1 -Status` နဲ့ container တွေ စစ်ပါ |
| Cloudflare 525/526 | SSL = Full (strict) ဖြစ်ရမယ်၊ Origin Certificate မှန်ရမယ် |

အသေးစိတ်: [`DEPLOY.md`](../DEPLOY.md)
