import * as vscode from "vscode";
import {
  IMAGE_PASTE_DIRECTORY,
  IMAGE_PASTE_MIME_TYPES,
  imagePasteExtension,
  imagePasteInsertion,
  nextImagePasteFileName,
} from "./image-paste";

/**
 * Cmd/Ctrl+V でクリップボードの画像を `assets/` に保存し、カーソル位置に参照を挿入する(#153)。
 * 保存と挿入は 1 つの paste edit なので、1 回の undo で両方戻る。
 */
export class ImagePasteEditProvider implements vscode.DocumentPasteEditProvider {
  static readonly kind = vscode.DocumentDropOrPasteEditKind.Empty.append("latex", "image");
  static readonly metadata: vscode.DocumentPasteProviderMetadata = {
    providedPasteEditKinds: [ImagePasteEditProvider.kind],
    pasteMimeTypes: IMAGE_PASTE_MIME_TYPES,
  };

  async provideDocumentPasteEdits(
    document: vscode.TextDocument,
    ranges: readonly vscode.Range[],
    dataTransfer: vscode.DataTransfer,
    _context: vscode.DocumentPasteEditContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentPasteEdit[] | undefined> {
    if (document.uri.scheme !== "file") return undefined;
    // 挿入する参照は 1 つ目のカーソルだけで決まり、それが全カーソルに入る。複数カーソルでは
    // 2 つ目以降に誤った参照が入りうるので、通常の貼り付けに任せる。
    if (ranges.length > 1) return undefined;
    const image = firstImage(dataTransfer);
    if (!image) return undefined;
    const directory = vscode.Uri.joinPath(document.uri, "..", IMAGE_PASTE_DIRECTORY);
    const existing = new Set((await listDirectory(directory)).map(([name]) => name));
    const name = nextImagePasteFileName(image.extension, (candidate) => existing.has(candidate));
    const relativePath = `${IMAGE_PASTE_DIRECTORY}/${name}`;
    const range = ranges[0] ?? new vscode.Range(0, 0, 0, 0);
    const offset = document.offsetAt(range.start);
    const insertion = imagePasteInsertion(document.getText(), offset, relativePath);
    // 参照を置けない位置(フレームの外)では画像を保存せず、通常の貼り付けに任せる。
    if (!insertion) return undefined;
    const moved = insertion.offset !== offset;
    const data = await image.file.data();
    if (token.isCancellationRequested) return undefined;
    const edit = new vscode.DocumentPasteEdit(
      // 挿入先を寄せるときは貼り付け範囲を書き換えない(選択中の文字を消さない)。
      moved ? document.getText(range) : insertion.text,
      `画像を ${relativePath} に保存して挿入`,
      ImagePasteEditProvider.kind,
    );
    edit.additionalEdit = new vscode.WorkspaceEdit();
    if (moved)
      edit.additionalEdit.insert(
        document.uri,
        document.positionAt(insertion.offset),
        insertion.text,
      );
    edit.additionalEdit.createFile(vscode.Uri.joinPath(directory, name), { contents: data });
    // テキストも一緒にコピーされているときは、既定を通常のテキスト貼り付けに譲る。
    if (dataTransfer.get("text/plain")) edit.yieldTo = [vscode.DocumentDropOrPasteEditKind.Text];
    return [edit];
  }
}

function firstImage(
  dataTransfer: vscode.DataTransfer,
): { file: vscode.DataTransferFile; extension: string } | undefined {
  for (const mimeType of IMAGE_PASTE_MIME_TYPES) {
    const file = dataTransfer.get(mimeType)?.asFile();
    const extension = imagePasteExtension(mimeType);
    if (file && extension) return { file, extension };
  }
  return undefined;
}

/** `assets/` が無ければ空。ディレクトリは createFile が作る。 */
async function listDirectory(directory: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return await vscode.workspace.fs.readDirectory(directory);
  } catch {
    return [];
  }
}
