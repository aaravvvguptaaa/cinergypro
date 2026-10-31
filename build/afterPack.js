// macOS: ad-hoc sign the bundle when building on a Mac, so locally built and CI-built apps launch
// on Apple Silicon. Windows: stamp the CinergyPro icon and version info into the .exe without Wine.
const { execFileSync } = require('child_process');

function signMac(ctx) {
  if (process.platform !== 'darwin') { console.log('  • skipping ad-hoc signing (needs macOS); run scripts/sign-mac.sh on the Mac after installing'); return; }
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  console.log('  • ad-hoc signing', app);
  execFileSync('bash', [path.join(__dirname, '..', 'scripts', 'sign-mac.sh'), app], { stdio: 'inherit' });
}
const path = require('path');
const fs = require('fs');
exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName === 'darwin') return signMac(ctx);
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit').then((m) => m.default || m);
  const exePath = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map((i) => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const ver = ctx.packager.appInfo.version.split('.').map(Number);
  vi.setFileVersion(ver[0], ver[1] || 0, ver[2] || 0, 0, 1033);
  vi.setProductVersion(ver[0], ver[1] || 0, ver[2] || 0, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'CinergyPro', ProductName: 'CinergyPro', CompanyName: 'CinergyPro',
    InternalName: 'CinergyPro', OriginalFilename: 'CinergyPro.exe', LegalCopyright: 'CinergyPro',
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
};
