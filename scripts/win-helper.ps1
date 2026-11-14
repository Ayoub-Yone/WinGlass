# Helper for scripts/verify-e2e.mjs: inspects the native taskbar, measures process memory,
# presses the emergency hotkey, probes lumabar's window visibility (hover, fullscreen + Alt+Tab).
# Prints one JSON object.
param(
  [Parameter(Mandatory = $true)][ValidateSet("taskbar", "memory", "hotkey", "windows", "hover", "fullscreen")][string]$Action,
  [int]$ProcessId = 0,
  [int]$X = 0,
  [int]$Y = 0
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LumabarProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct APPBARDATA { public uint cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public int l, t, r, b; public IntPtr lParam; }
  [DllImport("shell32.dll")] public static extern UIntPtr SHAppBarMessage(uint msg, ref APPBARDATA data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, System.Text.StringBuilder buf, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l, t, r, b; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  /// Visible top-level windows owned by `pid` (lumabar: dock + toast; the 1x1 sentinel and the 16x16 tao event target are ignored).
  public static int VisibleWindows(uint pid) {
    int count = 0;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); RECT rc; if (p == pid && IsWindowVisible(h) && GetWindowRect(h, out rc) && rc.r - rc.l > 32 && rc.b - rc.t > 32) count++; return true; }, IntPtr.Zero);
    return count;
  }
  public static string ForegroundClass() {
    var sb = new System.Text.StringBuilder(128);
    GetClassNameW(GetForegroundWindow(), sb, 128);
    return sb.ToString();
  }
  public static uint AppBarState() {
    APPBARDATA d = new APPBARDATA();
    d.cbSize = (uint)Marshal.SizeOf(typeof(APPBARDATA));
    d.hWnd = FindWindowW("Shell_TrayWnd", null);
    return (uint)SHAppBarMessage(4 /* ABM_GETSTATE */, ref d);
  }
  public static bool TrayVisible() { return IsWindowVisible(FindWindowW("Shell_TrayWnd", null)); }
  public static bool OverflowVisible() {
    IntPtr a = FindWindowW("TopLevelWindowForOverflowXamlIsland", null);
    IntPtr b = FindWindowW("NotifyIconOverflowWindow", null);
    return (a != IntPtr.Zero && IsWindowVisible(a)) || (b != IntPtr.Zero && IsWindowVisible(b));
  }
  public static void Chord(byte[] keys) {
    foreach (byte k in keys) keybd_event(k, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, 2 /* KEYUP */, UIntPtr.Zero);
  }
}
"@

function Pump([int]$ms) {
  $until = [DateTime]::UtcNow.AddMilliseconds($ms)
  while ([DateTime]::UtcNow -lt $until) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 15 }
}

switch ($Action) {
  "windows" {
    @{ visible = [LumabarProbe]::VisibleWindows([uint32]$ProcessId); trayVisible = [LumabarProbe]::TrayVisible() } | ConvertTo-Json -Compress
  }
  "hover" {
    # Park the cursor on the pill (hit-test makes the dock interactive) and make sure it stays up.
    [void][LumabarProbe]::SetProcessDPIAware()
    [void][LumabarProbe]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 700
    $during = [LumabarProbe]::VisibleWindows([uint32]$ProcessId)
    [void][LumabarProbe]::SetCursorPos($X, $Y - 300)
    Start-Sleep -Milliseconds 400
    @{ duringHover = $during; afterHover = [LumabarProbe]::VisibleWindows([uint32]$ProcessId); trayVisible = [LumabarProbe]::TrayVisible() } | ConvertTo-Json -Compress
  }
  "fullscreen" {
    # A real borderless fullscreen window in front -> dock hidden; Alt+Tab -> dock back at once.
    [void][LumabarProbe]::SetProcessDPIAware()
    Add-Type -AssemblyName System.Windows.Forms
    $pid32 = [uint32]$ProcessId
    $before = [LumabarProbe]::VisibleWindows($pid32)
    $form = New-Object System.Windows.Forms.Form
    $form.FormBorderStyle = "None"
    $form.StartPosition = "Manual"
    $form.Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $form.BackColor = [System.Drawing.Color]::Black
    $form.ShowInTaskbar = $true
    $form.Text = "lumabar fullscreen probe"
    $form.Show()
    # A synthetic Alt tap grants this process the right to take the foreground.
    [LumabarProbe]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [LumabarProbe]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][LumabarProbe]::SetForegroundWindow($form.Handle)
    $form.Activate()
    Pump 1300
    $fgIsProbe = [LumabarProbe]::GetForegroundWindow() -eq $form.Handle
    $inFullscreen = [LumabarProbe]::VisibleWindows($pid32)
    # Alt+Tab: hold Alt, tap Tab, sample while the switcher is up, then release.
    [LumabarProbe]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [LumabarProbe]::keybd_event(0x09, 0, 0, [UIntPtr]::Zero); [LumabarProbe]::keybd_event(0x09, 0, 2, [UIntPtr]::Zero)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $wakeMs = -1
    while ($sw.ElapsedMilliseconds -lt 1500) {
      [System.Windows.Forms.Application]::DoEvents()
      if ([LumabarProbe]::VisibleWindows($pid32) -gt 0) { $wakeMs = $sw.ElapsedMilliseconds; break }
      Start-Sleep -Milliseconds 10
    }
    $switcherClass = [LumabarProbe]::ForegroundClass()
    [LumabarProbe]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    Pump 500
    $afterAltTab = [LumabarProbe]::VisibleWindows($pid32)
    $fgAfter = [LumabarProbe]::ForegroundClass()
    $form.Close()
    $form.Dispose()
    Pump 400
    @{
      before = $before; inFullscreen = $inFullscreen; foregroundWasProbe = $fgIsProbe
      wakeMs = $wakeMs; switcherClass = $switcherClass; afterAltTab = $afterAltTab; foregroundAfter = $fgAfter
      afterClose = [LumabarProbe]::VisibleWindows($pid32)
    } | ConvertTo-Json -Compress
  }
  "taskbar" {
    $state = [LumabarProbe]::AppBarState()
    @{ autoHide = [bool]($state -band 1); visible = [LumabarProbe]::TrayVisible(); overflow = [LumabarProbe]::OverflowVisible() } | ConvertTo-Json -Compress
  }
  "hotkey" {
    # Ctrl + Alt + Shift + R
    [LumabarProbe]::Chord([byte[]](0x11, 0x12, 0x10, 0x52))
    @{ sent = $true } | ConvertTo-Json -Compress
  }
  "memory" {
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize, PrivatePageCount
    $ids = New-Object System.Collections.Generic.List[int]
    $ids.Add($ProcessId)
    $changed = $true
    while ($changed) {
      $changed = $false
      foreach ($p in $all) {
        if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { $ids.Add([int]$p.ProcessId); $changed = $true }
      }
    }
    $hostProc = $all | Where-Object { $_.ProcessId -eq $ProcessId }
    $children = $all | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.ProcessId -ne $ProcessId }
    @{
      hostWorkingSetMb = [math]::Round($hostProc.WorkingSetSize / 1MB, 1)
      hostPrivateMb    = [math]::Round($hostProc.PrivatePageCount / 1MB, 1)
      childCount       = @($children).Count
      childWorkingSetMb = [math]::Round((($children | Measure-Object WorkingSetSize -Sum).Sum) / 1MB, 1)
      webviewCount     = @($children | Where-Object { $_.Name -eq "msedgewebview2.exe" }).Count
    } | ConvertTo-Json -Compress
  }
}
