!macro customInstall
  ; Register folder context menu - "Open with CodePilot"
  WriteRegStr HKCU "Software\Classes\Directory\shell\CodePilot" "" "Open with CodePilot"
  WriteRegStr HKCU "Software\Classes\Directory\shell\CodePilot" "Icon" "$INSTDIR\CodePilot.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\CodePilot\command" "" '"$INSTDIR\CodePilot.exe" "%V"'

  ; Background context menu (right-click in folder background)
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\CodePilot" "" "Open with CodePilot"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\CodePilot" "Icon" "$INSTDIR\CodePilot.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\CodePilot\command" "" '"$INSTDIR\CodePilot.exe" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\CodePilot"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\CodePilot"
!macroend
