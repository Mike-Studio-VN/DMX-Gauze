; Build on Windows: ISCC.exe installer\gauze.iss  ->  Output\DMXGauzeSetup.exe
; Requires TouchDesigner already installed on the target machine.
[Setup]
AppName=DMX Gauze Controller
AppVersion=1.0
DefaultDirName={autopf}\DMX Gauze
DefaultGroupName=DMX Gauze
OutputBaseFilename=DMXGauzeSetup
OutputDir=Output
Compression=lzma
PrivilegesRequired=admin

[Files]
Source: "..\DMX_Gauze.toe"; DestDir: "{app}"; Flags: ignoreversion
; keep the operator's saved patch/limits/calibration across upgrades
Source: "..\config\gauze.json"; DestDir: "{app}\config"; Flags: onlyifdoesntexist uninsneveruninstall

[Dirs]
; the app writes config\gauze.json, so the folder must be writable by normal users
Name: "{app}\config"; Permissions: users-modify

[Icons]
Name: "{autodesktop}\DMX Gauze"; Filename: "{code:TdExe}"; Parameters: """{app}\DMX_Gauze.toe"""; WorkingDir: "{app}"
Name: "{group}\DMX Gauze"; Filename: "{code:TdExe}"; Parameters: """{app}\DMX_Gauze.toe"""; WorkingDir: "{app}"

[Code]
function TdExe(Param: string): string;
var p: string;
begin
  if RegQueryStringValue(HKLM, 'SOFTWARE\Derivative\TouchDesigner', 'InstallPath', p) then
    Result := AddBackslash(p) + 'bin\TouchDesigner.exe'
  else
    Result := 'C:\Program Files\Derivative\TouchDesigner\bin\TouchDesigner.exe';
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not FileExists(TdExe('')) then
    Result := MsgBox('TouchDesigner was not found at ' + TdExe('') + '.' + #13#10 +
      'Install it first, or continue and fix the shortcut later. Continue?', mbConfirmation, MB_YESNO) = IDYES;
end;
