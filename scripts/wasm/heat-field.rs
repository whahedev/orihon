#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

#[inline]
fn floor_i32(value: f32) -> i32 {
    let truncated = value as i32;
    if value < truncated as f32 { truncated - 1 } else { truncated }
}

#[inline]
fn ceil_i32(value: f32) -> i32 {
    let truncated = value as i32;
    if value > truncated as f32 { truncated + 1 } else { truncated }
}

/// e^-x for x in 0..4 without a host libm import. Evaluate a sixth-order Taylor
/// polynomial on x/16 (0..0.25), then square four times. This stays within the
/// Float32 tolerance of the JS/WebGPU exponential while remaining import-free.
#[inline]
fn exp_negative(value: f32) -> f32 {
    let x = value.max(0.0) * (1.0 / 16.0);
    let mut power = 1.0 + x * (-1.0 + x * (0.5 + x * (
        -0.16666667 + x * (0.041666668 + x * (-0.008333334 + x * 0.0013888889))
    )));
    let mut i = 0;
    while i < 4 {
        power *= power;
        i += 1;
    }
    power
}

/// Build one common Gaussian scalar field for heat colors and contours.
///
/// `points` is tightly packed `[mercator_x, mercator_y, weight]`. The output grid is
/// row-major Float32. First, all sources are bilinearly aggregated into a regular
/// spatial grid (cluster-like weighted cells). A separable Gaussian convolution then
/// costs O(points + cells * radius), rather than O(points * radius²).
#[no_mangle]
pub unsafe extern "C" fn heat_field_build(
    points_ptr: *const f32,
    point_count: u32,
    grid_ptr: *mut f32,
    scratch_ptr: *mut f32,
    cols: u32,
    rows: u32,
    west_merc: f32,
    north_merc: f32,
    width_merc: f32,
    height_merc: f32,
    kernel_merc: f32,
) -> f32 {
    if points_ptr.is_null()
        || grid_ptr.is_null()
        || scratch_ptr.is_null()
        || cols < 2
        || rows < 2
        || !(width_merc > 0.0)
        || !(height_merc > 0.0)
        || !(kernel_merc > 0.0)
    {
        return 0.0;
    }

    let cells = (cols as usize).saturating_mul(rows as usize);
    for i in 0..cells {
        *grid_ptr.add(i) = 0.0;
    }

    let radius_x = (kernel_merc / (width_merc / (cols - 1) as f32)).max(0.51);
    let radius_y = (kernel_merc / (height_merc / (rows - 1) as f32)).max(0.51);
    let ceil_x = ceil_i32(radius_x).max(1);
    let ceil_y = ceil_i32(radius_y).max(1);

    // Weighted cell aggregation. The four deposits preserve the source centroid
    // below grid resolution and make a million-point input a single linear pass.
    for index in 0..point_count as usize {
        let offset = index * 3;
        let mx = *points_ptr.add(offset);
        let my = *points_ptr.add(offset + 1);
        let weight = *points_ptr.add(offset + 2);
        if !mx.is_finite() || !my.is_finite() || !weight.is_finite() || weight <= 0.0 {
            continue;
        }
        let fx = ((mx - west_merc) / width_merc) * (cols - 1) as f32;
        let fy = ((my - north_merc) / height_merc) * (rows - 1) as f32;
        if fx < 0.0 || fy < 0.0 || fx > (cols - 1) as f32 || fy > (rows - 1) as f32 { continue; }
        let x0 = floor_i32(fx).max(0).min(cols as i32 - 1);
        let y0 = floor_i32(fy).max(0).min(rows as i32 - 1);
        let x1 = (x0 + 1).min(cols as i32 - 1);
        let y1 = (y0 + 1).min(rows as i32 - 1);
        let tx = (fx - x0 as f32).max(0.0).min(1.0);
        let ty = (fy - y0 as f32).max(0.0).min(1.0);
        *grid_ptr.add(y0 as usize * cols as usize + x0 as usize) += weight * (1.0 - tx) * (1.0 - ty);
        *grid_ptr.add(y0 as usize * cols as usize + x1 as usize) += weight * tx * (1.0 - ty);
        *grid_ptr.add(y1 as usize * cols as usize + x0 as usize) += weight * (1.0 - tx) * ty;
        *grid_ptr.add(y1 as usize * cols as usize + x1 as usize) += weight * tx * ty;
    }

    // Horizontal Gaussian pass.
    for y in 0..rows as i32 {
        for x in 0..cols as i32 {
            let from = (x - ceil_x).max(0);
            let to = (x + ceil_x).min(cols as i32 - 1);
            let mut value = 0.0_f32;
            for sx in from..=to {
                let d = (sx - x) as f32 / radius_x;
                let kernel = exp_negative(4.0 * d * d);
                value += *grid_ptr.add(y as usize * cols as usize + sx as usize) * kernel;
            }
            *scratch_ptr.add(y as usize * cols as usize + x as usize) = value;
        }
    }

    // Vertical Gaussian pass and peak reduction.
    let mut peak = 0.0_f32;
    for y in 0..rows as i32 {
        let from = (y - ceil_y).max(0);
        let to = (y + ceil_y).min(rows as i32 - 1);
        for x in 0..cols as i32 {
            let mut value = 0.0_f32;
            for sy in from..=to {
                let d = (sy - y) as f32 / radius_y;
                let kernel = exp_negative(4.0 * d * d);
                value += *scratch_ptr.add(sy as usize * cols as usize + x as usize) * kernel;
            }
            *grid_ptr.add(y as usize * cols as usize + x as usize) = value;
            peak = peak.max(value);
        }
    }
    peak
}
