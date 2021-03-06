/**
 * 条件编译loader
 * 1、可以处理wxss、js、wxs、wxml、json
 * 2、对文件内容进行条件编译
 * 3、缓存编译后的内容，在emit时候需要使用
 * 4、根据options中的fileMap替换内容
 */

import * as fs from 'fs';
import * as vm from 'vm'
import log from '../../../common/log';

import { IWebpackCompilerExt, IWebpack, ILooseObject } from '../../../interfaces';

 interface IIfElseOpts{
  /** 文件类型，json、js、css、wxss、html、wxml */
  fileType?: string;
  /** app参数，代表小程序类型 */
  app?: string;
  /** type参数，代表不同场景：wxxcx、h5、qqxcx、react */
  type?: string;
}

/**
 * 转换除json以外的其他文件
 * @param {String} code 源码内容
 * @param {String} fileType 源码类型：js\css\wxss\wxs\wxml\html
 */
function compileOthers (code: string, opts: IIfElseOpts): string {
  const { fileType, app, type } = opts;
  let annotationStart = '\\/\\*';
  let annotationEnd = '\\*\\/';
  if (fileType === 'wxml' || fileType === 'html') {
    annotationStart = '<!--';
    annotationEnd = '-->';
  }
  // dm语法
  const splitReg = new RegExp(`(${annotationStart}\\s*?\\/?dm-cli[\\s\\S]*?${annotationEnd})`);
  const codeAndAnnoArr = code.split(splitReg);
  if (codeAndAnnoArr.length <= 1) return code;

  // dm语法条件
  const matchReg = new RegExp(`${annotationStart}\\s*?dm-cli[\\s\\S]+?(if|else-if|else)([\\s\\S]*?)${annotationEnd}`);
  // dm语法结束
  const ifEndReg = new RegExp(`${annotationStart}\\s*?\\/dm-cli\\s*?${annotationEnd}`);

  let funcBody = 'let code = ``;';
  codeAndAnnoArr.forEach(fragment => {
    const matchResut = fragment.match(matchReg);
    if (matchResut) {
      const isIfStart = matchResut[1] === 'if';
      const isElseIf = matchResut[1] === 'else-if';
      const isElse = matchResut[1] === 'else';
      const condition = (matchResut[2] || '').replace(':', '');
      if (isIfStart && condition) {
        funcBody += `if(${condition}){`;
      } else if (isElseIf && condition) {
        funcBody += `} else if(${condition}){`;
      } else if (isElse) {
        funcBody += `} else {`;
      } else {
        throw new Error(`不支持的条件编译语法:${fragment}`);
      }
    } else if (ifEndReg.test(fragment)) {
      funcBody += `}`;
    } else {
      const validFrag = fragment
        .replace(/`/g, '_@_@_@_')
        .replace(/\${/g, '_#_#_#_')
        .replace(/\\/g, '_!_!_!_');
      funcBody += `code += \`${validFrag}\`;`; // `需要转义下，不然报错
    }
  });
  funcBody += 'return code.replace(/_@_@_@_/g, "`").replace(/_!_!_!_/g, "\\\\").replace(/_#_#_#_/g, "${");';
  /* eslint-disable no-new-func */
  try {
    return new Function('app', 'type', funcBody)(app, type);
  } catch (e) {
    throw new Error('条件编译存在语法错误' + e.message);
  }
};

/**
 * JSON文件条件编译
 * {
    "navigationBarTitleText": "首页",
    "wxaif(type=='qqxcx')navigationStyle": "custom"
   }
 * @param code json文件内容
 * @param app app参数值
 */
function compileJSON (code: string, opts: IIfElseOpts): string {
  const { app, type } = opts;
  const context = { app, type };
  vm.createContext(context);
  const json = JSON.parse(code);
  const ifelseReg = /^dmif\((.+)\)/
  const deepCompile = (target: ILooseObject): void => {
    for (const key in target) {
      if (ifelseReg.test(key)) {
        const script = new vm.Script(RegExp.$1);
        if (script.runInContext(context)) { // 表达式为真时,去除表达式，新增原始key
          const normalKey = key.replace(ifelseReg, '');
          target[normalKey] = target[key];
          if (typeof target[normalKey] === 'object') { // 新添加的key还有子属性,对象和数组都考虑
            deepCompile(target[normalKey])
          }
        }
        delete target[key];
      } else if (typeof target[key] === 'object') {
        deepCompile(target[key])
      }
    }
  }

  deepCompile(json);
  return JSON.stringify(json);
}

/**
 * 条件编译
 * @param {String} code 要编译的源码
 * wxml格式：
 * ~~~~~~~~~~~~~~~~~~~~~~~~~
 *  <!-- dm-cli if:app=='b' -->
 *  <view id="b">
 *  <!-- dm-cli else -->
 *  <view id="app">
 *  <!-- /dm-cli -->
 * ~~~~~~~~~~~~~~~~~~~~~~~~~
 * js/css/wxs/wxss格式：
 * ~~~~~~~~~~~~~~~~~~~~~~~~~
 * /* dm-cli if:app=='b' *\/
 * console.log('小程序B')
 * /* dm-cli else *\/
 * console.log('小程序')
 * /* /dm-cli  *\/
 * ~~~~~~~~~~~~~~~~~~~~~~~~~
 * json格式：
 * ~~~~~~~~~~~~~~~~~~~~~~~~~
 * {
 *    "navigationBarTitleText": "首页",
 *    "navigationBarTitleText.b": "小程序B首页"
 * }
 * ~~~~~~~~~~~~~~~~~~~~~~~~~
 * @param {IIfElseOpts} opts 可选参数
 */
function compile (code: string, opts: IIfElseOpts): string {
  opts.fileType = opts.fileType || 'js';
  opts.type = opts.type || 'wxxcx';
  opts.app = opts.app || '';

  return opts.fileType === 'json' ? compileJSON(code, opts) : compileOthers(code, opts)
}

const exportFun = function (this: IWebpack.loader.LoaderContext, content: string): string {
  this.cacheable && this.cacheable();
  const query = this.query || {};
  const compiler = this._compiler as IWebpackCompilerExt;
  const resourcePath = query.fileMap ? this.query.fileMap[this.resourcePath] : ''; // 后缀区分，文件映射
  if (resourcePath) {
    content = fs.readFileSync(resourcePath, 'utf-8');
    log.debug('添加依赖->', resourcePath)
    this.addDependency(resourcePath) // 将待后缀的作为依赖项，每次构建，this都是一个新的实例，不用担心重复添加问题
  }
  const { fileType, type, app } = query;
  const compiledContent = compile(content, { fileType, type, app });
  compiler.$fileCache!.set(this.resourcePath, compiledContent);
  return compiledContent;
}

exportFun.compile = compile; // compile单独导出

// 注意loader的导出不能使用export default function
export = exportFun
