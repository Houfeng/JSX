var Class = require("./Class");
eval(Class.$import("./parser"));
eval(Class.$import("./classdef"));
eval(Class.$import("./type"));
eval(Class.$import("./jsemitter"));
eval(Class.$import("./platform"));
eval(Class.$import("./util"));

"use strict";

// for front-end driver
exports.Platform = Platform;

var Compiler = exports.Compiler = Class.extend({

	$MODE_COMPILE: 0,
	$MODE_PARSE: 1,

	initialize: function (platform) {
		this._platform = platform;
		this._mode = Compiler.MODE_COMPILE;
		this._classDefs = [];
		this._templateClassDefs = [];
		this._templateInstantiationRequests = [];
		this._output = "";
		// load the built-in classes
		this._sourceFiles = [
			"lib/built-in/Object.jsx",
			"lib/built-in/Boolean.jsx",
			"lib/built-in/Number.jsx",
			"lib/built-in/String.jsx",
			"lib/built-in/RegExp.jsx",
			"lib/built-in/Date.jsx",
			"lib/built-in/Array.jsx",
			"lib/built-in/Hash.jsx"
		];
		this._fileCache = {};
		if (! this._precompile())
			throw new Error("logic flaw");
		Type._initializeBuiltin(this._classDefs);
		// reset source file list
		this._sourceFiles = [];
	},

	setMode: function (mode) {
		this._mode = mode;
		return this;
	},

	setEmitter: function (emitter) {
		this._emitter = emitter;
	},

	setOutputFile: function (outputFile) {
		this._outputFile = outputFile;
	},

	addSourceFile: function (file) {
		for (var i = 0; i < this._sourceFiles.length; ++i)
			if (this._sourceFiles[i] === file)
				return;
		this._sourceFiles.push(file);
	},

	compile: function () {
		if (! this._precompile())
			return false;
		switch (this._mode) {
		case Compiler.MODE_PARSE:
			this._output = ClassDefinition.serialize(this._classDefs);
			return true;
		}
		// TODO control flow analysis
		// TODO optimize
		this._generateCode();
		return true;
	},

	_precompile: function () {
		var errors = []; // new CompileError[]()
		// parse all files
		for (var i = 0; i < this._sourceFiles.length; ++i) {
			if (! this.parseFile(errors, this._sourceFiles[i])) {
				this._printErrors(errors);
				return false;
			}
		}
		switch (this._mode) {
		case Compiler.MODE_PARSE:
			return true;
		}
		// template instantiation
		this._instantiateTemplates(errors);
		if (errors.length != 0) {
			this._printErrors(errors);
			return false;
		}
		// semantic analysis
		this._resolveTypes(errors);
		if (errors.length != 0) {
			this._printErrors(errors);
			return false;
		}
		this._analyze(errors);
		if (errors.length != 0) {
			this._printErrors(errors);
			return false;
		}
		return true;
	},

	getOutput: function() {
		return this._output;
	},

	getFileContent: function(filename) {
		if(this._fileCache[filename] == null) {
			this._fileCache[filename] = this._platform.load(filename);
		}
		return this._fileCache[filename];
	},

	parseFile: function (errors, filename) {
		// read file
		var content = null;
		var exception = "";
		try {
			content = this.getFileContent(filename);
		}
		catch (e) {
			exception = ": " + e.toString();
		}
		if (content == null) {
			errors.push(new CompileError(filename, 0, "could not open the file" + exception));
			return false;
		}
		// parse
		var parser = new Parser(filename, content, errors);
		parser.parse();
		if (errors.length != 0)
			return false;
		// fetch the results
		var success = true;
		var parsedClassDefs = parser.getClassDefs();
		for (var i = 0; i < parsedClassDefs.length; ++i) {
			var parsedClassDef = parsedClassDefs[i];
			if (ClassDefinition.getClass(this._classDefs, parsedClassDef.className()) == null) {
				this._classDefs.push(parsedClassDef);
			} else {
				// FIXME error location should be fixed (will de after "import")
				errors.push(new CompileError(filename, 0, "definition for class '" + parsedClassDef.className() + "' already exists"));
				succeeded = false;
			}
		}
		var parsedTemplateClassDefs = parser.getTemplateClassDefs();
		for (var i = 0; i < parsedTemplateClassDefs.length; ++i) {
			var parsedTemplateClassDef = parsedTemplateClassDefs[i];
			if (TemplateClassDefinition.getClass(this._templateClassDefs, parsedTemplateClassDef.className()) == null) {
				this._templateClassDefs.push(parsedTemplateClassDef);
			} else {
				// FIXME error location should be fixed (will de after "import")
				errors.push(new CompileError(filename, 0, "definition for class '" + parsedTemplateClassDef.className() + "' already exists"));
				succeeded = false;
			}
		}
		if (! success)
			return false;
		this._templateInstantiationRequests = this._templateInstantiationRequests.concat(parser.getTemplateInstantiationRequests());
		return true;
	},

	_instantiateTemplates: function (errors) {
		for (var i = 0; i < this._templateInstantiationRequests.length; ++i)
			this._instantiateTemplate(errors, this._templateInstantiationRequests[i], false);
	},

	_instantiateTemplate: function (errors, request, resolveImmmediately) {
		var concreteClassName = Type.templateTypeToString(request.getClassName(), request.getTypeArguments());
		// return immediately if instantiated already
		var classDef = ClassDefinition.getClass(this._classDefs, concreteClassName);
		if (classDef != null)
			return classDef;
		// instantiate
		var templateClass = TemplateClassDefinition.getClass(this._templateClassDefs, request.getClassName());
		if (templateClass == null) {
			errors.push(new CompileError(request.getToken(), "could not find template class definition for '" + request.getClassName() + "'"));
			return null;
		}
		classDef = templateClass.instantiate(errors, request);
		if (classDef == null)
			return null;
		// register
		this._classDefs.push(classDef);
		// resolve immediately if requested to
		if (resolveImmmediately) {
			classDef.resolveTypes(
				new AnalysisContext(
					errors,
					this._classDefs,
					(function (errors, request) {
						return this._instantiateTemplate(errors, request, true);
					}).bind(this)));
		}
		// return
		return classDef;
	},

	_resolveTypes: function (errors) {
		for (var i = 0; i < this._classDefs.length; ++i)
			this._classDefs[i].resolveTypes(
				new AnalysisContext(
					errors,
					this._classDefs,
					(function (errors, request) {
						return this._instantiateTemplate(errors, request, false);
					}).bind(this)));
	},

	_analyze: function (errors) {
		for (var i = 0; i < this._classDefs.length; ++i)
			this._classDefs[i].analyze(
				new AnalysisContext(
					errors,
					this._classDefs,
					(function (errors, request) {
						return this._instantiateTemplate(errors, request, true);
					}).bind(this)));
	},

	_generateCode: function () {
		for (var i = 0; i < this._classDefs.length; ++i) {
			var classDef = this._classDefs[i];
			if ((classDef.flags() & ClassDefinition.IS_NATIVE) == 0)
				this._emitter.emitClassDefinition(classDef);
		}
		for (var i = 0; i < this._classDefs.length; ++i)
			this._emitter.emitStaticInitializationCode(this._classDefs[i]);
		this._output = this._emitter.getOutput();
	},

	_printErrors: function (errors) {
		for (var i = 0; i < errors.length; ++i) {
			this._platform.error(errors[i].toString(this));
		}
	}

});

// vim: set noexpandtab:
