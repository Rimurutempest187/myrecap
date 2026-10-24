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
