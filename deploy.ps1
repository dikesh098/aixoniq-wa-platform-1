<#
  Aixoniq WhatsApp Platform - one-command deploy (Windows PowerShell 5.1 or 7)

  Run from this folder:
    powershell -ExecutionPolicy Bypass -File .\deploy.ps1

  Before you start, have ready:
    1. A Supabase project (supabase.com > New project). You need its project ref, anon key and database password.
    2. An admin user: Supabase > Authentication > Users > Add user (email + password, auto-confirm).
    3. A Vercel account (free).
  Secrets you type are written only to git-ignored local files and to Supabase/Vercel. Re-running is safe.
#>
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Green }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE). Fix the error above, then run deploy.ps1 again." } }
function New-Secret { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join '' }
function Plain($s) {
  if (-not $s -or $s.Length -eq 0) { return '' }
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}
function Sq([string]$s) { $s.Replace("'", "''") }
function Save($rel, $text) { [IO.File]::WriteAllText((Join-Path $PSScriptRoot $rel), $text, (New-Object Text.UTF8Encoding $false)) }
function Sb { npx --yes supabase@latest @args }
function Vc { npx --yes vercel@latest @args }

Step 'Checking Node.js'
try { $v = (node --version) -replace '^v', '' } catch { throw 'Node.js is not installed. Install the LTS version from https://nodejs.org and reopen PowerShell.' }
if ([int]$v.Split('.')[0] -lt 20) { throw "Node $v is too old. Install Node 20 or newer from https://nodejs.org." }
Write-Host "Node $v OK"

Step 'Your details'
$ref = (Read-Host 'Supabase project ref (the abcd1234 part of https://abcd1234.supabase.co)').Trim()
if ($ref -notmatch '^[a-z0-9]{10,30}$') { throw 'That does not look like a project ref.' }
$anon = (Read-Host 'Supabase anon public key (Project Settings > API; NOT the service_role key)').Trim()
if ($anon.Length -lt 20) { throw 'Anon key looks too short.' }
$dbPw = Plain (Read-Host 'Supabase database password' -AsSecureString)
if (-not $dbPw) { throw 'Database password is required to apply migrations.' }
$adminEmail = (Read-Host 'Admin login email (the user you created in Supabase Authentication > Users)').Trim()
if ($adminEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'Invalid email.' }
$adminName = (Read-Host 'Your name').Trim(); if (-not $adminName) { $adminName = 'Owner' }
Write-Host "`nMeta WhatsApp credentials are optional now. Press Enter to skip and run in test mode." -ForegroundColor Yellow
$metaToken = Plain (Read-Host 'META_ACCESS_TOKEN (system-user token)' -AsSecureString)
$metaSecret = Plain (Read-Host 'META_APP_SECRET' -AsSecureString)
$supabaseUrl = "https://$ref.supabase.co"

Step 'Installing dependencies and building'
npm install; Check 'npm install'
npm run build; Check 'Build (npm run build)'

Step 'Deploying the dashboard to Vercel'
Write-Host 'A browser window will open to sign in to Vercel.'
Vc login; Check 'Vercel login'
Vc link --yes; Check 'Vercel link'
foreach ($pair in @(@('VITE_SUPABASE_URL', $supabaseUrl), @('VITE_SUPABASE_ANON_KEY', $anon))) {
  try { Vc env rm $pair[0] production --yes 2>&1 | Out-Null } catch { }
  $global:LASTEXITCODE = 0
  $pair[1] | Vc env add $pair[0] production; Check "Setting $($pair[0])"
}
Vc deploy --prod --yes; Check 'Vercel deploy'
$site = (Read-Host "`nEnter your production URL shown above (e.g. https://aixoniq-wa-platform.vercel.app)").Trim().TrimEnd('/')
if ($site -notmatch '^https://') { throw 'The URL must start with https://' }

Step 'Linking Supabase'
$env:SUPABASE_DB_PASSWORD = $dbPw
Sb login; Check 'Supabase login'
Sb link --project-ref $ref; Check 'Supabase link'

Step 'Preparing server secrets'
$verify = ''; $worker = ''
if (Test-Path 'supabase\functions\.env') {   # re-run: keep the same secrets so Vault and functions stay in sync
  foreach ($l in Get-Content 'supabase\functions\.env') {
    if ($l -match '^WEBHOOK_VERIFY_TOKEN=(.+)$') { $verify = $Matches[1] }
    if ($l -match '^WORKER_SECRET=(.+)$') { $worker = $Matches[1] }
  }
}
if (-not $verify) { $verify = New-Secret }
if (-not $worker) { $worker = New-Secret }
$envText = "WEBHOOK_VERIFY_TOKEN=$verify`nWORKER_SECRET=$worker`nALLOWED_ORIGIN=$site`n"
if ($metaToken) { $envText += "META_ACCESS_TOKEN=$metaToken`n" }
if ($metaSecret) { $envText += "META_APP_SECRET=$metaSecret`n" }
Save 'supabase\functions\.env' $envText

# Local, git-ignored migration: stores the cron secrets in Vault and grants your admin role.
$sql = @"
delete from vault.secrets where name in ('project_url', 'worker_secret');
select vault.create_secret('$(Sq $supabaseUrl)', 'project_url');
select vault.create_secret('$(Sq $worker)', 'worker_secret');
do `$`$ begin
  if not exists (select 1 from auth.users where email = '$(Sq $adminEmail)') then
    raise exception 'Admin user $(Sq $adminEmail) not found. Create it in Supabase Authentication > Users, then re-run deploy.ps1.';
  end if;
end `$`$;
insert into public.staff (user_id, full_name, role)
select id, '$(Sq $adminName)', 'admin' from auth.users where email = '$(Sq $adminEmail)'
on conflict (user_id) do update set role = 'admin', full_name = excluded.full_name;
"@
Save 'supabase\migrations\005_local_setup.sql' $sql

Step 'Applying database migrations'
'Y' | npx --yes supabase@latest db push; Check 'Database migration'

Step 'Deploying server functions'
Sb secrets set --env-file supabase/functions/.env --project-ref $ref; Check 'Setting secrets'
Sb functions deploy queue-worker --no-verify-jwt --use-api --project-ref $ref; Check 'Deploying queue-worker'
Sb functions deploy whatsapp-webhook --no-verify-jwt --use-api --project-ref $ref; Check 'Deploying whatsapp-webhook'
Sb functions deploy sync-templates --use-api --project-ref $ref; Check 'Deploying sync-templates'
Sb functions deploy send-test-message --use-api --project-ref $ref; Check 'Deploying send-test-message'

Step 'Done'
Write-Host "Dashboard:        $site" -ForegroundColor Green
Write-Host "Sign in with:     $adminEmail (the password you set in Supabase)"
Write-Host "Mode:             TEST MODE (nothing is sent to WhatsApp until you turn it off in Settings)"
Write-Host "`nFor Meta (README step 6) you will need:"
Write-Host "  Webhook callback URL: $supabaseUrl/functions/v1/whatsapp-webhook"
Write-Host "  Webhook verify token: $verify"
if (-not $metaToken -or -not $metaSecret) {
  Write-Host "`nMeta token/app secret were skipped. When ready, add META_ACCESS_TOKEN and META_APP_SECRET to supabase\functions\.env and run:" -ForegroundColor Yellow
  Write-Host "  npx supabase secrets set --env-file supabase/functions/.env --project-ref $ref"
}
