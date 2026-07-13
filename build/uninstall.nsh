!macro customUnInstall
  ; Remove Nyxon app data on uninstall
  RMDir /r "$APPDATA\nyxon-launcher"
  RMDir /r "$LOCALAPPDATA\nyxon-launcher"
  RMDir /r "$LOCALAPPDATA\Nyxon Launcher"
  DeleteRegKey HKCU "Software\nyxon-launcher"
!macroend