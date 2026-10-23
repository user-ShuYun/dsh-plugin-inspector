#!/usr/bin/env node
/**
 * 安装 / 卸载 dsh-plugin-inspector（用 Node 写，避免 PowerShell 的引号和编码坑）。
 *
 *   node install.mjs            安装到 web profile（自动备份补丁）
 *   node install.mjs --remove   从 profile 移除（重启 DSH 即恢复）
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const profileDir = join(homedir(), '.dsh', 'profiles', 'web');
const patch = join(profileDir, 'cordis.patch.yml');
const target = join(profileDir, 'node_modules', 'dsh-plugin-inspector');
const remove = process.argv.includes('--remove');

if (!existsSync(patch)) {
  console.error('找不到 profile 补丁: ' + patch);
  process.exit(1);
}

// 1) 备份
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
copyFileSync(patch, `${patch}.bak-${stamp}`);
console.log('备份: cordis.patch.yml.bak-' + stamp);

// 2) 去掉已有的 inspector 块（幂等）
let yaml = readFileSync(patch, 'utf8');
yaml = yaml.replace(/^- insert:\r?\n\s+- id: dsh-plugin-inspector\r?\n(?:[ \t].*\r?\n?)*/gm, '');

if (remove) {
  writeFileSync(patch, yaml.trimEnd() + '\n', 'utf8');
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  console.log('已移除：补丁条目 + 插件目录。重启 DSH 生效。');
  process.exit(0);
}

// 3) 复制插件目录
mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
cpSync(here, target, {
  recursive: true,
  filter: (src) => !src.includes(`${join(here, 'node_modules')}`) && !src.endsWith('.zip')
});

// 4) 追加插入块
const block = [
  '- insert:',
  '    - id: dsh-plugin-inspector',
  '      name: dsh-plugin-inspector',
  '      config:',
  '        allowTools: []'
].join('\n');
writeFileSync(patch, yaml.trimEnd() + '\n' + block + '\n', 'utf8');

console.log('已安装: ' + target);
console.log('补丁已更新。重启 DSH 后：');
console.log('  · 右下角 🛠 按钮 / Ctrl+Shift+P 打开面板');
console.log('  · 或直接访问 http://127.0.0.1:3080/plugins/dsh-plugin-inspector/page');
console.log('撤销: node install.mjs --remove');
