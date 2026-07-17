import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const sourceRoot = join(process.cwd(), 'src');

function controllerFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return path.endsWith('.controller.ts') ? [path] : [];
  });
}

function hasDecorator(node: ts.Node, names: Set<string>): boolean {
  return ts.canHaveDecorators(node) && (ts.getDecorators(node) ?? []).some((decorator) => {
    const expression = decorator.expression;
    const name = ts.isCallExpression(expression) ? expression.expression : expression;
    return ts.isIdentifier(name) && names.has(name.text);
  });
}

test('every controller handler declares guard or intentional public metadata', () => {
  const failures: string[] = [];
  for (const file of controllerFiles(sourceRoot)) {
    const source = readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    tree.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) return;
      const classHasAuth = hasDecorator(node, new Set(['UseGuards', 'Public']));
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.canHaveDecorators(member)) continue;
        if (classHasAuth || hasDecorator(member, new Set(['UseGuards', 'Public']))) continue;
        failures.push(`${relative(process.cwd(), file)}:${member.name.getText(tree)}`);
      }
    });
  }
  assert.deepEqual(failures, [], `Controller handlers missing auth metadata: ${failures.join(', ')}`);
});
