var gulp = require('gulp');

//___________________________________________________

gulp.task('default', ['lint', 'uglify']);
gulp.task('lint', ['jslint']);

//___________________________________________________
// npm i --save-dev gulp-jshint jshint-stylish
var jshint = require('gulp-jshint'),
	stylish = require('jshint-stylish');

gulp.task('jslint', function() {
	gulp.src('./index.js')
		.pipe(jshint())
		.pipe(jshint.reporter(stylish));
});
//___________________________________________________
// npm i --save-dev gulp-live-server
var gls = require('gulp-live-server');

gulp.task('serve-test', function() {
	var server = gls.static("./test", 8287);
	server.start();
	//live reload changed resource(s) 
	gulp.watch(['index.js', 'test/**/*.js'], server.notify);
});
//___________________________________________________
// npm i --save-dev gulp-uglifyjs gulp-rename
var uglify = require('gulp-uglifyjs'),
	rename = require("gulp-rename");

gulp.task('uglify', function() {
	gulp.src('index.js')
		.pipe(uglify({
			preserveComments: 'some',
			ouput: {
				comments: 'some'
			}
		}))
		.pipe(rename('deep-promise.min.js'))
		.pipe(gulp.dest('dist'));
});