var gulp = require('gulp');
//___________________________________________________

gulp.task('default', ['lint']);
gulp.task('lint', ['jslint']);

//___________________________________________________
// npm i --save-dev gulp-jshint jshint-stylish
var jshint = require('gulp-jshint'),
    stylish = require('jshint-stylish');

gulp.task('jslint', function() {
    gulp.src(['./index.js', './lib/*.js'])
        .pipe(jshint())
        .pipe(jshint.reporter(stylish));
});