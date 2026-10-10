[English](README.md) · 简体中文

# Revia

**留下改动，保住细节。**

放入原图和修改图，Revia 自动对齐位置、匹配颜色并生成蒙版，把修改图中的改动合回原图。需要时用两支画笔微调，再导出。图片处理全部在你的设备上完成。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/editor-dark.png">
  <img src="images/editor-light.png" alt="Revia 左右对比合成结果与修改图">
</picture>

## 三步完成

1. **放入两张图片。** 自动开始位置对齐、颜色匹配和蒙版生成。
2. **按需微调。** 用**添加**保留修改图内容，用**擦除**恢复原图。调整画笔大小和柔和度，在结果或蒙版上直接绘制，随时撤销。
3. **导出。** 从格式菜单选择 PNG、蒙版 PNG 或 PSD。

打开**左右对比**，拖动竖向分隔线查看合成结果与修改图，两侧共用缩放和平移。

**高级**项默认收起，只在需要时调整位置、颜色匹配强度和识别灵敏度。默认设置会根据图片自动处理。

刷新或重新打开后从空白开始，结束前请导出结果。

## 示例：给杯子换个颜色

修改图中蓝色杯子清晰，但背景细节有所损失。Revia 自动识别杯子并生成蒙版，蒙版外保留原图像素。多余的改动可以擦除，遗漏的细节可以用画笔补上。

| 原图 | 修改图 | 自动合成结果 |
| --- | --- | --- |
| ![红色杯子原图](images/mug-original.png) | ![杯子清晰、背景降质的修改图](images/mug-edited-degraded.jpg) | ![自动合成结果](images/mug-result.png) |

可以直接使用[原图](images/mug-original.png)和[修改图](images/mug-edited-degraded.jpg)尝试，处理完成后自动显示结果。

## 开始使用

安装 [Node.js 24 或更新版本](https://nodejs.org/)，拉取仓库后，在仓库目录打开终端。

使用 Node.js 自带的 npm：

```sh
npm install
npm start
```

也可以使用 pnpm：

```sh
pnpm install
pnpm start
```

首次启动会构建应用、启动本地服务，并自动打开浏览器。编辑时保持终端运行，结束后按 `Ctrl+C` 停止服务。本项目不发布 npm 包。

运行 `npm run desktop` 或 `pnpm desktop` 可打开桌面应用。在 Windows 上运行 `npm run package:win` 或 `pnpm package:win`，会在 `release/` 中生成 x64 ZIP。解压后运行 `Revia.exe` 即可。

## 命令行使用

安装依赖后，可以直接提供两张图片导出结果，使用与编辑界面相同的自动处理流程。无需启动浏览器或先构建应用。

```sh
npm run cli -- -i images/mug-original.png -e images/mug-edited-degraded.jpg -o result.png -f png
```

也可以使用 pnpm：

```sh
pnpm cli -i images/mug-original.png -e images/mug-edited-degraded.jpg -o result.png -f png
```

使用 `-f mask` 导出 16 位蒙版 PNG，使用 `-f psd` 导出分层 PSD。省略 `-f` 时，根据 `.png` 或 `.psd` 扩展名选择格式。输出保持原图尺寸，只有添加 `--overwrite` 才会覆盖已有文件。

需要时可以添加 `--color-strength 0.8`、`--sensitivity 1.2`、`--feather 4` 或 `--offset-x -2` 等参数。位置偏移以原图像素为单位；自动对齐后，`--scale` 和 `--rotation` 围绕原图画布中心缩放、旋转，再应用平移，随后按调整后的位置匹配颜色、识别蒙版。使用 `--align none` 手动指定位置，或用 `--local-warp off` 关闭边界局部对齐。

动画默认使用第一帧，也可通过 `--original-frame` 和 `--edited-frame` 指定帧号，从 1 开始。终端会显示处理进度，`--quiet` 可隐藏进度和完成提示。导出失败时返回非零退出码。

查看全部参数和默认值：

```sh
npm run cli -- --help
pnpm cli --help
```

## 支持的能力

- 导入 PNG、JPEG 和 WebP；动画图片可选择一帧。
- 原尺寸输出、8K 图片，以及受支持的 16 位 PNG 和 ICC 色彩配置。
- 自动位置对齐、颜色匹配、可编辑蒙版，以及当前编辑期间的撤销和重做。
- 深浅主题；简体中文、繁体中文、英文、日文、韩文。默认跟随系统，不支持的系统语言使用英文。
- 首次资源下载完成后可离线使用，不上传图片。

蒙版中的白色采用修改图，黑色保留原图，灰色按权重混合。蒙版外保持原图解码后的像素值。PSD 支持已验证的 8 位色彩配置，PNG 可保留受支持的更高位深图像数据。

版本更新内容见 [Changelog](CHANGELOG.md)。

## 开源许可

Revia 采用 [Apache License 2.0](LICENSE) 开源许可证。
