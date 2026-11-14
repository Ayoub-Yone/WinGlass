# Helper for scripts/verify-e2e.mjs: inspects the native taskbar, measures process memory and
# presses the emergency hotkey. Prints one JSON object.
param(
  [Parameter(Mandatory = $true)][ValidateSet("taskbar", "memory", "hotkey")][string]$Action,
  [int]$ProcessId = 0
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
  public static uint AppBarState() {
    APPBARDATA d = new APPBARDATA();
    d.cbSize = (uint)Marshal.SizeOf(typeof(APPBARDATA));
    d.hWnd = FindWindowW("Shell_TrayWnd", null);
    return (uint)SHAppBarMessage(4 /* ABM_GETSTATE */, ref d);
  }
  public static bool TrayVisible() { return IsWindowVisible(FindWindowW("Shell_TrayWnd", null)); }
  public static void Chord(byte[] keys) {
    foreach (byte k in keys) keybd_event(k, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, 2 /* KEYUP */, UIntPtr.Zero);
  }
}
"@

switch ($Action) {
  "taskbar" {
    $state = [LumabarProbe]::AppBarState()
    @{ autoHide = [bool]($state -band 1); visible = [LumabarProbe]::TrayVisible() } | ConvertTo-Json -Compress
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
