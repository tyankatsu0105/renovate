import { MAVEN_REPO } from '../../datasource/maven/common';
import * as datasourceSbtPackage from '../../datasource/sbt-package';
import * as datasourceSbtPlugin from '../../datasource/sbt-plugin';
import { get } from '../../versioning';
import * as mavenVersioning from '../../versioning/maven';
import { PackageDependency, PackageFile } from '../common';

const isComment = (str: string): boolean => /^\s*\/\//.test(str);

const isSingleLineDep = (str: string): boolean =>
  /^\s*(libraryDependencies|dependencyOverrides)\s*\+=\s*/.test(str);

const isDepsBegin = (str: string): boolean =>
  /^\s*(libraryDependencies|dependencyOverrides)\s*\+\+=\s*/.test(str);

const isPluginDep = (str: string): boolean =>
  /^\s*addSbtPlugin\s*\(.*\)\s*$/.test(str);

const isStringLiteral = (str: string): boolean => /^"[^"]*"$/.test(str);

const isScalaVersion = (str: string): boolean =>
  /^\s*scalaVersion\s*:=\s*"[^"]*"[\s,]*$/.test(str);

const getScalaVersion = (str: string): string =>
  str.replace(/^\s*scalaVersion\s*:=\s*"/, '').replace(/"[\s,]*$/, '');

/*
  https://www.scala-sbt.org/release/docs/Cross-Build.html#Publishing+conventions
 */
const normalizeScalaVersion = (str: string): string => {
  // istanbul ignore if
  if (!str) {
    return str;
  }
  const versioning = get(mavenVersioning.id);
  if (versioning.isVersion(str)) {
    // Do not normalize unstable versions
    if (!versioning.isStable(str)) {
      return str;
    }
    // Do not normalize versions prior to 2.10
    if (!versioning.isGreaterThan(str, '2.10.0')) {
      return str;
    }
  }
  if (/^\d+\.\d+\.\d+$/.test(str)) {
    return str.replace(/^(\d+)\.(\d+)\.\d+$/, '$1.$2');
  }
  // istanbul ignore next
  return str;
};

const isScalaVersionVariable = (str: string): boolean =>
  /^\s*scalaVersion\s*:=\s*[_a-zA-Z][_a-zA-Z0-9]*[\s,]*$/.test(str);

const getScalaVersionVariable = (str: string): string =>
  str.replace(/^\s*scalaVersion\s*:=\s*/, '').replace(/[\s,]*$/, '');

const isResolver = (str: string): boolean =>
  /^\s*(resolvers\s*\+\+?=\s*(Seq\()?)?"[^"]*"\s*at\s*"[^"]*"[\s,)]*$/.test(
    str
  );
const getResolverUrl = (str: string): string =>
  str
    .replace(/^\s*(resolvers\s*\+\+?=\s*(Seq\()?)?"[^"]*"\s*at\s*"/, '')
    .replace(/"[\s,)]*$/, '');

const isVarDependency = (str: string): boolean =>
  /^\s*(private\s*)?(lazy\s*)?val\s[_a-zA-Z][_a-zA-Z0-9]*\s*=.*(%%?).*%.*/.test(
    str
  );

const isVarDef = (str: string): boolean =>
  /^\s*(private\s*)?(lazy\s*)?val\s+[_a-zA-Z][_a-zA-Z0-9]*\s*=\s*"[^"]*"\s*$/.test(
    str
  );

const getVarName = (str: string): string =>
  str
    .replace(/^\s*(private\s*)?(lazy\s*)?val\s+/, '')
    .replace(/\s*=\s*"[^"]*"\s*$/, '');

const isVarName = (str: string): boolean =>
  /^[_a-zA-Z][_a-zA-Z0-9]*$/.test(str);

const getVarInfo = (str: string, ctx: ParseContext): { val: string } => {
  const rightPart = str.replace(
    /^\s*(private\s*)?(lazy\s*)?val\s+[_a-zA-Z][_a-zA-Z0-9]*\s*=\s*"/,
    ''
  );
  const val = rightPart.replace(/"\s*$/, '');
  return { val };
};

interface ParseContext {
  scalaVersion: string;
  variables: any;
  depType?: string;
}

function parseDepExpr(
  expr: string,
  ctx: ParseContext
): PackageDependency | null {
  const { scalaVersion, variables } = ctx;
  let { depType } = ctx;

  const isValidToken = (str: string): boolean =>
    isStringLiteral(str) || (isVarName(str) && !!variables[str]);

  const resolveToken = (str: string): string =>
    isStringLiteral(str)
      ? str.replace(/^"/, '').replace(/"$/, '')
      : variables[str].val;

  const tokens = expr
    .trim()
    .replace(/[()]/g, '')
    .split(/\s*(%%?)\s*|\s*classifier\s*/);

  const [
    rawGroupId,
    groupOp,
    rawArtifactId,
    artifactOp,
    rawVersion,
    scopeOp,
    rawScope,
  ] = tokens;

  if (!rawGroupId) {
    return null;
  }
  if (!isValidToken(rawGroupId)) {
    return null;
  }

  if (!rawArtifactId) {
    return null;
  }
  if (!isValidToken(rawArtifactId)) {
    return null;
  }
  if (artifactOp !== '%') {
    return null;
  }

  if (!rawVersion) {
    return null;
  }
  if (!isValidToken(rawVersion)) {
    return null;
  }

  if (scopeOp && scopeOp !== '%') {
    return null;
  }

  const groupId = resolveToken(rawGroupId);
  const depName = `${groupId}:${resolveToken(rawArtifactId)}`;
  const artifactId =
    groupOp === '%%' && scalaVersion
      ? `${resolveToken(rawArtifactId)}_${scalaVersion}`
      : resolveToken(rawArtifactId);
  const lookupName = `${groupId}:${artifactId}`;
  const currentValue = resolveToken(rawVersion);

  if (!depType && rawScope) {
    depType = rawScope.replace(/^"/, '').replace(/"$/, '');
  }

  const result: PackageDependency = {
    depName,
    lookupName,
    currentValue,
  };

  if (depType) {
    result.depType = depType;
  }

  return result;
}
interface ParseOptions {
  isMultiDeps?: boolean;
  scalaVersion?: string;
  variables?: Record<string, any>;
}

function parseSbtLine(
  acc: PackageFile & ParseOptions,
  line: string,
  lineIndex: number,
  lines: string[]
): (PackageFile & ParseOptions) | null {
  const { deps, registryUrls, variables } = acc;

  let { isMultiDeps, scalaVersion } = acc;

  const ctx: ParseContext = {
    scalaVersion,
    variables,
  };

  let dep: PackageDependency = null;
  let scalaVersionVariable: string = null;
  if (!isComment(line)) {
    if (isScalaVersion(line)) {
      isMultiDeps = false;
      scalaVersion = normalizeScalaVersion(getScalaVersion(line));
    } else if (isScalaVersionVariable(line)) {
      isMultiDeps = false;
      scalaVersionVariable = getScalaVersionVariable(line);
    } else if (isResolver(line)) {
      isMultiDeps = false;
      const url = getResolverUrl(line);
      registryUrls.push(url);
    } else if (isVarDef(line)) {
      variables[getVarName(line)] = getVarInfo(line, ctx);
    } else if (isVarDependency(line)) {
      isMultiDeps = false;
      const depExpr = line.replace(
        /^\s*(private\s*)?(lazy\s*)?val\s[_a-zA-Z][_a-zA-Z0-9]*\s*=\s*/,
        ''
      );
      dep = parseDepExpr(depExpr, {
        ...ctx,
      });
    } else if (isSingleLineDep(line)) {
      isMultiDeps = false;
      const depExpr = line.replace(/^.*\+=\s*/, '');
      dep = parseDepExpr(depExpr, {
        ...ctx,
      });
    } else if (isPluginDep(line)) {
      isMultiDeps = false;
      const rightPart = line.replace(/^\s*addSbtPlugin\s*\(/, '');
      const depExpr = rightPart.replace(/\)\s*$/, '');
      dep = parseDepExpr(depExpr, {
        ...ctx,
        depType: 'plugin',
      });
    } else if (isDepsBegin(line)) {
      isMultiDeps = true;
    } else if (isMultiDeps) {
      const rightPart = line.replace(/^[\s,]*/, '');
      const depExpr = rightPart.replace(/[\s,]*$/, '');
      dep = parseDepExpr(depExpr, {
        ...ctx,
      });
    }
  }

  if (dep) {
    if (dep.depType === 'plugin') {
      dep.datasource = datasourceSbtPlugin.id;
    } else {
      dep.datasource = datasourceSbtPackage.id;
    }
    deps.push({
      registryUrls,
      ...dep,
    });
  }

  if (lineIndex + 1 < lines.length) {
    return {
      ...acc,
      isMultiDeps,
      scalaVersion:
        scalaVersion ||
        (scalaVersionVariable &&
          variables[scalaVersionVariable] &&
          normalizeScalaVersion(variables[scalaVersionVariable].val)),
    };
  }
  if (deps.length) {
    return { deps };
  }
  return null;
}

export function extractPackageFile(content: string): PackageFile {
  if (!content) {
    return null;
  }
  const lines = content.split(/\n/);
  return lines.reduce(parseSbtLine, {
    registryUrls: [MAVEN_REPO],
    deps: [],
    isMultiDeps: false,
    scalaVersion: null,
    variables: {},
  });
}
