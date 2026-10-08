#Requires -Version 5.0
<#
  opencode-max Windows tray icon (PowerShell NotifyIcon, no binaries).
  JSON protocol over stdio:
    stdin:  {"action":"add-item","index":0,"title":"...","enabled":true}
            {"action":"update-item","index":1,"title":"...","enabled":true}
            {"action":"set-tooltip","text":"..."}
            {"action":"kill"}
    stdout: {"type":"ready"} | {"type":"click","index":0}
#>
param(
  [string]$Tooltip = "opencode-max",
  [string]$IconPath = ""
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = $Tooltip.Substring(0, [Math]::Min(63, $Tooltip.Length))
$notify.Visible = $true
if ($IconPath -ne "" -and (Test-Path $IconPath)) {
  try { $notify.Icon = New-Object System.Drawing.Icon($IconPath) } catch { }
}
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$notify.ContextMenuStrip = $menu
$items = @{}

function Add-Item([int]$index, [string]$title, [bool]$enabled) {
  $mi = New-Object System.Windows.Forms.ToolStripMenuItem($title)
  $mi.Enabled = $enabled
  $mi.Add_Click({ Write-Output (@{ type = "click"; index = $index } | ConvertTo-Json -Compress) })
  [void]$menu.Items.Add($mi)
  $items[$index] = $mi
}

Write-Output (@{ type = "ready" } | ConvertTo-Json -Compress)

$running = $true
while ($running) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try { $cmd = $line | ConvertFrom-Json } catch { continue }
  switch ($cmd.action) {
    "add-item"    { Add-Item ([int]$cmd.index) ([string]$cmd.title) ([bool]$cmd.enabled) }
    "update-item" {
      $i = [int]$cmd.index
      if ($items.ContainsKey($i)) {
        $items[$i].Text = [string]$cmd.title
        $items[$i].Enabled = [bool]$cmd.enabled
      }
    }
    "set-tooltip" { $notify.Text = ([string]$cmd.text).Substring(0, [Math]::Min(63, ([string]$cmd.text).Length)) }
    "kill"        { $running = $false }
  }
  [System.Windows.Forms.Application]::DoEvents()
}

$notify.Visible = $false
$notify.Dispose()
