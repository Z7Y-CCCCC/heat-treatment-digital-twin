# 离线许可证签发工具

这是给软件交付方使用的本地 GUI 工具。它只监听 `127.0.0.1`，启动后会自动打开浏览器，不需要联网。

## 使用方式

可以双击本目录里的 `启动许可证工具.cmd`，也可以在项目根目录执行：

```powershell
node tools/license-generator/license-generator.cjs
```

第一次使用：

1. 点击“生成密钥对”。密钥只生成一次，务必备份 `license-private-key.pem`。
2. 把 `license-public-key.pem` 部署到客户安装目录的数据目录。私钥不能进入客户电脑。
3. 客户打开后台“设置 → 授权与版本”，复制“本机授权指纹”发给签发方。
4. 在本工具填写客户、有效期、机器指纹和功能，点击“签名并生成许可证”。
5. 把 `issued` 文件夹里的许可证 JSON 发给客户，客户在后台粘贴并点击“校验并安装”。

如果许可证不绑定机器，可以留空“客户机授权指纹”，但这只能限制签名许可证的滥用，不能阻止 JSON 被复制到另一台已部署同一公钥的电脑。生产交付建议绑定机器。

客户机的授权指纹以 Windows `ProgramData` 中的持久安装锚点为主，并保留硬件指纹兼容校验。因此普通系统更新、应用升级或一次硬件查询失败不会让许可证失效。锚点采用原子写入，并有 `machine-identity.json.bak` 备用文件，避免断电写坏后误换指纹。不要在客户机上手动删除 `C:\ProgramData\HeatTreatmentDigitalTwin\machine-identity.json`；它不是缓存，而是授权锚点。系统重装、清理该文件或把整套授权数据迁移到另一台电脑，属于需要重新激活的场景。

`license-private-key.pem` 和 `issued/*.json` 已通过本目录的 `.gitignore` 排除。不要把私钥提交到 Git、安装包或前端代码。
