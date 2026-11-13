# 发布待办（npm + 插件市场）

代码已经在 GitHub：https://github.com/yulineveryday/dsh-onebot-douyin （v0.3.0 tag 已打）。
还差最后两步，都需要 npm 账号授权。

## 1. 发布到 npm

前置（二选一）：

- 在 https://www.npmjs.com/settings/tokens 生成 Classic → Automation token，写入环境变量 NPM_TOKEN；
- 或在本机执行 npm login 一次，用已保存的凭据。

发布：

```bash
cd D:/WORK1/onebot-douyin
npm publish --access public        # 或用 pnpm publish --access public --no-git-checks
```

反悔可用 npm unpublish dsh-onebot-douyin@0.3.0 --force（72 小时内）。

## 2. 验证能被 dsh 装

```bash
dsh plugin add dsh-onebot-douyin
dsh plugin list
```

装完在插件配置里 confirm driver=douyin、port=5711，然后 /qrcode 扫码。

## 3. 进插件市场（收录仓库）

市场索引 https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json 只收 npm 上已发布的插件，
条目形如：name / title / description{en,zh} / homepage / repository{url} /
metadata{category: identity} / versions[{version, source:{type: npm}}]。
收录入口是 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin ，按它的 CONTRIBUTING 提 PR。

## 备注

- 包名 dsh-onebot-douyin 在 npm 上未被占用（2026-11-13 查，registry 返回 404）。
- GitHub 授权用的 token 存在 D:/WORK1/_edgepb/gh_token.txt（scope=repo），不用了可以到
  https://github.com/settings/tokens 撤销，并删掉该文件。